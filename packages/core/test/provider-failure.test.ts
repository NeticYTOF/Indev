import { describe, expect, it } from 'vitest';
import {
  createProviderFailureCollector,
  parseGatewayFailureCode,
  parseGatewayUpstreamStatus,
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

  it('rejects inherited object keys as transport cause codes', () => {
    expect(transportCodeForCause({ cause: { code: 'toString' } })).toBe('transport_network');
    expect(transportCodeForCause({ cause: { code: 'constructor' } })).toBe('transport_network');
    expect(transportCodeForCause({ cause: { code: '__proto__' } })).toBe('transport_network');
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

  it('rejects fractional and out-of-range status and identity numbers', () => {
    const collector = createProviderFailureCollector(clockSequence([
      { wallMs: 10, monotonicMs: 20 },
      { wallMs: 12, monotonicMs: 24 },
    ]));
    collector.record({
      endpointClass: 'stations/markers',
      phase: 'scan',
      sampleOrdinal: 1.5,
      dispatchSeq: Number.MAX_SAFE_INTEGER + 1,
      httpStatus: 200.5,
      code: 'http_other',
    });
    collector.record({
      endpointClass: 'none',
      phase: 'run',
      httpStatus: 600,
      code: 'unknown',
    });
    const [first, second] = collector.snapshot().failures;
    expect(first).toMatchObject({ sampleOrdinal: null, dispatchSeq: null, httpStatus: null });
    expect(second).toMatchObject({ httpStatus: null });
  });

  it('keeps monotonic domain continuity across malformed later readings', () => {
    const collector = createProviderFailureCollector(clockSequence([
      { wallMs: 100, monotonicMs: 500 },
      { wallMs: 200, monotonicMs: Number.NaN },
      { wallMs: 210, monotonicMs: 600 },
    ]));
    collector.record({ endpointClass: 'none', phase: 'run', code: 'unknown' });
    collector.record({ endpointClass: 'none', phase: 'run', code: 'unknown' });
    const [first, second] = collector.snapshot().failures;
    expect(first!.elapsedWallMs).toBe(100);
    expect(first!.elapsedMonotonicMs).toBe(0);
    expect(second!.elapsedWallMs).toBe(110);
    expect(second!.elapsedMonotonicMs).toBe(100);
  });

  it('never evaluates accessor properties on a malicious input object', () => {
    const collector = createProviderFailureCollector(clockSequence([
      { wallMs: 0, monotonicMs: 0 },
      { wallMs: 10, monotonicMs: 10 },
    ]));
    const input = Object.create(null) as Record<string, unknown>;
    for (const key of ['endpointClass', 'phase', 'sampleOrdinal', 'dispatchSeq', 'httpStatus', 'code']) {
      Object.defineProperty(input, key, {
        get() { throw new Error(`must not read ${key}`); },
        enumerable: true,
      });
    }
    expect(() => collector.record(input as never)).not.toThrow();
    const first = collector.snapshot().failures[0]!;
    expect(first).toMatchObject({
      endpointClass: 'none',
      phase: 'run',
      sampleOrdinal: null,
      dispatchSeq: null,
      httpStatus: null,
      code: 'unknown',
    });
  });

  it('survives proxy descriptor traps without policy impact', () => {
    const collector = createProviderFailureCollector(clockSequence([
      { wallMs: 0, monotonicMs: 0 },
      { wallMs: 10, monotonicMs: 10 },
    ]));
    let trapRan = false;
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() { trapRan = true; throw new Error('trap'); },
    });
    expect(() => collector.record(hostile as never)).not.toThrow();
    expect(trapRan).toBe(true);
    expect(collector.snapshot().failures[0]).toMatchObject({ code: 'unknown' });
  });

  it('establishes a monotonic baseline from the first valid reading only', () => {
    const collector = createProviderFailureCollector(clockSequence([
      { wallMs: 100, monotonicMs: Number.NaN },
      { wallMs: 110, monotonicMs: 500 },
      { wallMs: 120, monotonicMs: 550 },
    ]));
    collector.record({ endpointClass: 'none', phase: 'run', code: 'unknown' });
    collector.record({ endpointClass: 'none', phase: 'run', code: 'unknown' });
    collector.record({ endpointClass: 'none', phase: 'run', code: 'unknown' });
    const records = collector.snapshot().failures;
    expect(records.map((r) => r.elapsedMonotonicMs)).toEqual([0, 50, 50]);
    expect(records.map((r) => r.elapsedWallMs)).toEqual([10, 20, 20]);
  });

  it('keeps monotonic elapsed stable when the monotonic clock never becomes valid', () => {
    const collector = createProviderFailureCollector(clockSequence([
      { wallMs: 100, monotonicMs: Number.NaN },
      { wallMs: 120, monotonicMs: -1 },
      { wallMs: 130, monotonicMs: Number.POSITIVE_INFINITY },
    ]));
    collector.record({ endpointClass: 'none', phase: 'run', code: 'unknown' });
    collector.record({ endpointClass: 'none', phase: 'run', code: 'unknown' });
    collector.record({ endpointClass: 'none', phase: 'run', code: 'unknown' });
    expect(collector.snapshot().failures.map((r) => r.elapsedMonotonicMs)).toEqual([0, 0, 0]);
  });

  it('parses gateway diagnostic fields with exact allowlists only', () => {
    for (const code of [
      'input_invalid', 'upstream_http', 'upstream_timeout', 'upstream_transport',
      'upstream_json', 'upstream_contract', 'normalization_failed', 'gateway_unknown',
    ]) {
      expect(parseGatewayFailureCode(code)).toBe(code);
    }
    for (const bad of [
      ' UPSTREAM_HTTP', 'upstream_http ', 'UPSTREAM_HTTP', 'upstream_http\n',
      'upstream_http\u0000', 'x'.repeat(1000), '', null, 7,
    ]) {
      expect(parseGatewayFailureCode(bad)).toBeNull();
    }
    expect(parseGatewayUpstreamStatus('100')).toBe(100);
    expect(parseGatewayUpstreamStatus('599')).toBe(599);
    for (const bad of ['+429', '429x', '4e2', ' 429', '429 ', '099', '600', '', 429, null]) {
      expect(parseGatewayUpstreamStatus(bad)).toBeNull();
    }
  });

  it('sanitizes gateway metadata independently inside the collector', () => {
    const collector = createProviderFailureCollector(clockSequence([
      { wallMs: 0, monotonicMs: 0 }, { wallMs: 1, monotonicMs: 1 },
    ]));
    collector.record({
      endpointClass: 'stations/markers', phase: 'scan', sampleOrdinal: 1,
      code: 'http_400', httpStatus: 400,
      gatewayFailureCode: 'upstream_http',
      gatewayUpstreamStatus: '429' as never,
    });
    collector.record({
      endpointClass: 'stations/markers', phase: 'scan', sampleOrdinal: 2,
      code: 'http_400', httpStatus: 400,
      gatewayFailureCode: 'not_allowed' as never,
      gatewayUpstreamStatus: 500 as never,
    });
    const records = collector.snapshot().failures;
    expect(records[0]).toMatchObject({ gatewayFailureCode: 'upstream_http', gatewayUpstreamStatus: 429 });
    expect(records[1]).toMatchObject({ gatewayFailureCode: null, gatewayUpstreamStatus: null });
  });
});
