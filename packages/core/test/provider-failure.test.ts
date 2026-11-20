import { describe, expect, it } from 'vitest';
import {
  createProviderFailureCollector,
  transportCodeForCause,
  PROVIDER_FAILURE_LIMIT,
  type ProviderFailureClock,
} from '../src/provider-failure.js';

function clockSequence(values: Array<{ wallMs: number; monotonicMs: number }>): ProviderFailureClock {
  let i = 0;
  return { now: () => values[Math.min(i++, values.length - 1)] ?? { wallMs: 0, monotonicMs: 0 } };
}

describe('provider failure diagnostics', () => {
  it('bounds retained records during execution with an exact omitted count', () => {
    const collector = createProviderFailureCollector(clockSequence([
      { wallMs: 100, monotonicMs: 500 },
      { wallMs: 115, monotonicMs: 530 },
    ]));
    for (let i = 0; i < PROVIDER_FAILURE_LIMIT + 7; i++) {
      collector.record({
        endpointClass: 'stations/markers',
        phase: 'scan',
        sampleOrdinal: i + 1,
        dispatchSeq: i + 1,
        httpStatus: 500,
        code: 'http_5xx',
      });
    }
    const report = collector.snapshot();
    expect(report.failures).toHaveLength(PROVIDER_FAILURE_LIMIT);
    expect(report.omittedFailureCount).toBe(7);
    expect(report.failures[0]).toMatchObject({
      sampleOrdinal: 1,
      dispatchSeq: 1,
      elapsedWallMs: 15,
      elapsedMonotonicMs: 30,
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.failures)).toBe(true);
    expect(Object.isFrozen(report.failures[0])).toBe(true);
  });

  it('never invokes malicious nested cause getters or proxy traps', () => {
    const throwingAccessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(throwingAccessor, 'cause', {
      get() { throw new Error('must not run'); },
      enumerable: true,
    });
    expect(transportCodeForCause(throwingAccessor)).toBe('transport_network');

    const proxy = new Proxy({}, {
      get() { throw new Error('must not run'); },
      getOwnPropertyDescriptor() { throw new Error('must not run'); },
    });
    expect(transportCodeForCause({ cause: proxy })).toBe('transport_network');
    expect(transportCodeForCause({ cause: { code: { toString() { throw new Error('must not run'); } } } })).toBe('transport_network');
  });

  it('maps only allowlisted primitive cause codes', () => {
    expect(transportCodeForCause(new TypeError('opaque'))).toBe('transport_type_error');
    expect(transportCodeForCause({ cause: { code: 'ECONNRESET' } })).toBe('transport_connection_reset');
    expect(transportCodeForCause({ cause: { code: 'evil string with secret' } })).toBe('transport_network');
  });

  it('clamps rollback, NaN, infinity, and negative clocks without exposing them', () => {
    const collector = createProviderFailureCollector(clockSequence([
      { wallMs: Number.NaN, monotonicMs: Number.POSITIVE_INFINITY },
      { wallMs: -100, monotonicMs: -50 },
      { wallMs: 20, monotonicMs: 30 },
      { wallMs: 10, monotonicMs: 5 },
    ]));
    collector.record({
      endpointClass: 'none', phase: 'run', code: 'deadline',
      dispatchSeq: Number.NaN, httpStatus: -1,
    });
    collector.record({
      endpointClass: 'none', phase: 'run', code: 'unknown',
      dispatchSeq: -4, httpStatus: Number.POSITIVE_INFINITY,
    });
    const first = collector.snapshot().failures[0]!;
    expect(first.elapsedWallMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(first.elapsedWallMs)).toBe(true);
    expect(Number.isFinite(first.elapsedMonotonicMs)).toBe(true);
    expect(first.dispatchSeq).toBeNull();
    expect(first.httpStatus).toBeNull();
    expect(first.sampleOrdinal).toBeNull();
  });

  it('treats wall and monotonic rollback as zero elapsed time', () => {
    const collector = createProviderFailureCollector(clockSequence([
      { wallMs: 100, monotonicMs: 500 },
      { wallMs: 20, monotonicMs: 400 },
    ]));
    collector.record({ endpointClass: 'none', phase: 'run', code: 'deadline' });
    const first = collector.snapshot().failures[0]!;
    expect(first.elapsedWallMs).toBe(0);
    expect(first.elapsedMonotonicMs).toBe(0);
  });
});
