/**
 * Bounded, privacy-safe provider failure evidence for one planning run.
 *
 * This NEVER carries credentials, headers, URLs, raw bodies, error messages,
 * coordinates, station IDs, or arbitrary error object strings. Only allowlisted
 * primitive fields are copied into frozen completion records.
 */

export type ProviderEndpointClass =
  | 'stations/markers'
  | 'stations/details'
  | 'none';

export type ProviderFailurePhase =
  | 'scan'
  | 'details'
  | 'route'
  | 'run';

export type ProviderFailureCode =
  | 'http_400'
  | 'http_401'
  | 'http_403'
  | 'http_404'
  | 'http_409'
  | 'http_429'
  | 'http_4xx_other'
  | 'http_5xx'
  | 'http_other'
  | 'transport_type_error'
  | 'transport_timeout'
  | 'transport_abort'
  | 'transport_connection_reset'
  | 'transport_dns'
  | 'transport_connection_refused'
  | 'transport_network'
  | 'body_read_failure'
  | 'invalid_json'
  | 'nonfresh_provenance'
  | 'invalid_marker_list'
  | 'invalid_marker_record'
  | 'invalid_details_shape'
  | 'invalid_connector_availability'
  | 'invalid_charger_power'
  | 'invalid_tariff'
  | 'null_station'
  | 'ok_false_response'
  | 'station_id_mismatch'
  | 'route_failed'
  | 'budget_exhausted'
  | 'deadline'
  | 'fatal_throttled'
  | 'fatal_auth'
  | 'unknown';

export interface ProviderFailureEvidence {
  endpointClass: ProviderEndpointClass;
  phase: ProviderFailurePhase;
  /** 1-based scan sample ordinal; details/route/run records use null. */
  sampleOrdinal: number | null;
  /** Dispatch sequence after successful reservation; predispatch uses null. */
  dispatchSeq: number | null;
  httpStatus: number | null;
  code: ProviderFailureCode;
  elapsedWallMs: number;
  elapsedMonotonicMs: number;
}

export interface ProviderFailureReport {
  /** First failures in emission order; each record is immutable. */
  failures: readonly ProviderFailureEvidence[];
  /** Exact count not retained because the first-20 cap was reached. */
  omittedFailureCount: number;
}

export interface ProviderCallContext {
  endpointClass: ProviderEndpointClass;
  phase: ProviderFailurePhase;
  sampleOrdinal?: number | null;
  /** Local evidence callback; transport swallows callback failures. */
  onDispatch?: (dispatchSeq: number) => void;
}

export interface ProviderFailureInput extends ProviderCallContext {
  code: ProviderFailureCode;
  dispatchSeq?: number | null;
  httpStatus?: number | null;
}

export interface ProviderFailureClock {
  now(): { wallMs: number; monotonicMs: number };
}

export const PROVIDER_FAILURE_LIMIT = 20;

const FAILURE_CODES: readonly ProviderFailureCode[] = [
  'http_400', 'http_401', 'http_403', 'http_404', 'http_409', 'http_429',
  'http_4xx_other', 'http_5xx', 'http_other',
  'transport_type_error', 'transport_timeout', 'transport_abort',
  'transport_connection_reset', 'transport_dns', 'transport_connection_refused',
  'transport_network',
  'body_read_failure', 'invalid_json', 'nonfresh_provenance',
  'invalid_marker_list', 'invalid_marker_record', 'invalid_details_shape',
  'invalid_connector_availability', 'invalid_charger_power', 'invalid_tariff',
  'null_station', 'ok_false_response', 'station_id_mismatch', 'route_failed',
  'budget_exhausted', 'deadline', 'fatal_throttled', 'fatal_auth',
  'unknown',
];

const TRANSPORT_CAUSE_CODES: Readonly<Record<string, ProviderFailureCode>> = Object.freeze(Object.assign(Object.create(null), {
  ECONNRESET: 'transport_connection_reset',
  ETIMEDOUT: 'transport_timeout',
  ENOTFOUND: 'transport_dns',
  EAI_AGAIN: 'transport_dns',
  ECONNREFUSED: 'transport_connection_refused',
  EPIPE: 'transport_network',
  UND_ERR_CONNECT_TIMEOUT: 'transport_timeout',
  UND_ERR_HEADERS_TIMEOUT: 'transport_timeout',
  UND_ERR_BODY_TIMEOUT: 'transport_timeout',
  UND_ERR_SOCKET: 'transport_network',
  UND_ERR_CLOSED: 'transport_network',
  UND_ERR_ABORTED: 'transport_abort',
}));

function safeElapsedClock(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function safePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function safeHttpStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

/** Own DATA properties only; accessor results are never evaluated. */
function ownDataValue(value: unknown, key: string): unknown {
  try {
    if (value === null || typeof value !== 'object') return undefined;
    // A proxy can trap descriptor lookup. The trap may execute, but its
    // result is discarded on failure and never affects policy or output.
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeIsTypeError(value: unknown): boolean {
  try {
    return value instanceof TypeError;
  } catch {
    return false;
  }
}

export function isProviderFailureCode(value: unknown): value is ProviderFailureCode {
  return typeof value === 'string' && (FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * Map only an allowlisted primitive `error.cause.code`; no message or name is
 * inspected. TypeError is a class check, not an error-name string comparison.
 */
export function transportCodeForCause(error: unknown): ProviderFailureCode {
  try {
    const cause = ownDataValue(error, 'cause');
    const code = ownDataValue(cause, 'code');
    if (typeof code === 'string') {
      const mapped = TRANSPORT_CAUSE_CODES[code];
      if (isProviderFailureCode(mapped)) return mapped;
    }
    return safeIsTypeError(error) ? 'transport_type_error' : 'transport_network';
  } catch {
    return 'transport_network';
  }
}

export function statusCodeForHttp(status: number | null): ProviderFailureCode {
  if (status === 400) return 'http_400';
  if (status === 401) return 'http_401';
  if (status === 403) return 'http_403';
  if (status === 404) return 'http_404';
  if (status === 409) return 'http_409';
  if (status === 429) return 'http_429';
  if (status != null && status >= 500 && status <= 599) return 'http_5xx';
  if (status != null && status >= 400 && status <= 499) return 'http_4xx_other';
  return 'http_other';
}


function defaultNow(): { wallMs: number; monotonicMs: number } {
  const wallMs = safeElapsedClock(Date.now()) ?? 0;
  let monotonicMs = wallMs;
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      monotonicMs = safeElapsedClock(performance.now()) ?? wallMs;
    }
  } catch { /* wall fallback */ }
  return { wallMs, monotonicMs };
}

interface ClockReading {
  wallMs: number;
  monotonicMs: number | null;
}

function safeNow(
  clock: ProviderFailureClock,
  previous: ClockReading | undefined,
): ClockReading {
  let wallMs = previous?.wallMs ?? safeElapsedClock(Date.now()) ?? 0;
  // A monotonic domain is never seeded from wall time. It starts null and is
  // established only by the first valid monotonic sample.
  let monotonicMs = previous?.monotonicMs ?? null;
  try {
    const now = clock.now();
    const nextWall = safeElapsedClock(ownDataValue(now, 'wallMs'));
    const nextMonotonic = safeElapsedClock(ownDataValue(now, 'monotonicMs'));
    if (nextWall != null) wallMs = nextWall;
    if (nextMonotonic != null) monotonicMs = nextMonotonic;
  } catch { /* keep last valid domain values */ }
  return { wallMs, monotonicMs };
}

function elapsed(start: number, now: number, previousElapsed: number): number {
  const delta = now - start;
  const candidate = Number.isFinite(delta) && delta >= 0 ? Math.round(delta) : 0;
  return Math.max(previousElapsed, Math.min(candidate, 2_147_483_647));
}

export interface ProviderFailureCollector {
  record(input: ProviderFailureInput): void;
  snapshot(): ProviderFailureReport;
}

export function emptyProviderFailureReport(): ProviderFailureReport {
  return Object.freeze({
    failures: Object.freeze([] as ProviderFailureEvidence[]),
    omittedFailureCount: 0,
  });
}

export function createProviderFailureCollector(
  clock: ProviderFailureClock = { now: defaultNow },
): ProviderFailureCollector {
  const start = safeNow(clock, undefined);
  let previous = start;
  let monotonicStart = start.monotonicMs;
  let wallElapsed = 0;
  let monotonicElapsed = 0;
  const failures: ProviderFailureEvidence[] = [];
  let omittedFailureCount = 0;

  return {
    record(input: ProviderFailureInput): void {
      try {
        const now = safeNow(clock, previous);
        previous = now;
        wallElapsed = elapsed(start.wallMs, now.wallMs, wallElapsed);
        if (now.monotonicMs != null) {
          if (monotonicStart == null) monotonicStart = now.monotonicMs;
          monotonicElapsed = elapsed(monotonicStart, now.monotonicMs, monotonicElapsed);
        }
        const inputRecord = input as unknown;
        const endpointInput = ownDataValue(inputRecord, 'endpointClass');
        const phaseInput = ownDataValue(inputRecord, 'phase');
        const sampleInput = ownDataValue(inputRecord, 'sampleOrdinal');
        const dispatchInput = ownDataValue(inputRecord, 'dispatchSeq');
        const statusInput = ownDataValue(inputRecord, 'httpStatus');
        const codeInput = ownDataValue(inputRecord, 'code');
        const record: ProviderFailureEvidence = Object.freeze({
          endpointClass: endpointInput === 'stations/markers' ||
            endpointInput === 'stations/details' ? endpointInput : 'none',
          phase: phaseInput === 'scan' || phaseInput === 'details' ||
            phaseInput === 'route' || phaseInput === 'run' ? phaseInput : 'run',
          sampleOrdinal: phaseInput === 'scan' ? safePositiveInteger(sampleInput) : null,
          dispatchSeq: safePositiveInteger(dispatchInput),
          httpStatus: safeHttpStatus(statusInput),
          code: isProviderFailureCode(codeInput) ? codeInput : 'unknown',
          elapsedWallMs: wallElapsed,
          elapsedMonotonicMs: monotonicElapsed,
        });
        if (failures.length < PROVIDER_FAILURE_LIMIT) failures.push(record);
        else omittedFailureCount += 1;
      } catch { /* diagnostics never alter run behavior */ }
    },
    snapshot(): ProviderFailureReport {
      return Object.freeze({
        failures: Object.freeze(failures.slice()),
        omittedFailureCount,
      });
    },
  };
}
