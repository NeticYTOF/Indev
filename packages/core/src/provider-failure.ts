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
  | 'station_id_mismatch'
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
  'station_id_mismatch',
  'budget_exhausted', 'deadline', 'fatal_throttled', 'fatal_auth',
  'unknown',
];

const TRANSPORT_CAUSE_CODES: Readonly<Record<string, ProviderFailureCode>> = {
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
};

function safeNonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function safePositiveInteger(value: unknown): number | null {
  const n = safeNonnegative(value);
  return n != null && n > 0 ? n : null;
}

/** Own DATA properties only: accessors and proxy traps never run. */
function ownDataValue(value: unknown, key: string): unknown {
  try {
    if (value === null || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
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
      if (mapped) return mapped;
    }
    return error instanceof TypeError ? 'transport_type_error' : 'transport_network';
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
  const wallMs = Date.now();
  const monotonicMs =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : wallMs;
  return { wallMs, monotonicMs };
}

function safeNow(clock: ProviderFailureClock): { wallMs: number; monotonicMs: number } {
  try {
    const now = clock.now();
    return {
      wallMs: safeNonnegative(now?.wallMs) ?? Date.now(),
      monotonicMs: safeNonnegative(now?.monotonicMs) ?? Date.now(),
    };
  } catch {
    const fallback = Date.now();
    return { wallMs: fallback, monotonicMs: fallback };
  }
}

function elapsed(start: number, now: number): number {
  const delta = now - start;
  return Number.isFinite(delta) && delta >= 0 ? Math.round(delta) : 0;
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
  const start = safeNow(clock);
  const failures: ProviderFailureEvidence[] = [];
  let omittedFailureCount = 0;

  return {
    record(input: ProviderFailureInput): void {
      // Collection can never change budgets, retry decisions, or policy.
      try {
        const now = safeNow(clock);
        const record: ProviderFailureEvidence = Object.freeze({
          endpointClass:
            input.endpointClass === 'stations/markers' ||
            input.endpointClass === 'stations/details'
              ? input.endpointClass
              : 'none',
          phase:
            input.phase === 'scan' ||
            input.phase === 'details' ||
            input.phase === 'route' ||
            input.phase === 'run'
              ? input.phase
              : 'run',
          sampleOrdinal:
            input.phase === 'scan' ? safePositiveInteger(input.sampleOrdinal) : null,
          dispatchSeq: safePositiveInteger(input.dispatchSeq),
          httpStatus: safeNonnegative(input.httpStatus),
          code: isProviderFailureCode(input.code) ? input.code : 'unknown',
          elapsedWallMs: elapsed(start.wallMs, now.wallMs),
          elapsedMonotonicMs: elapsed(start.monotonicMs, now.monotonicMs),
        });
        if (failures.length < PROVIDER_FAILURE_LIMIT) failures.push(record);
        else omittedFailureCount += 1;
      } catch {
        /* Diagnostics are best-effort and must not alter any run outcome. */
      }
    },
    snapshot(): ProviderFailureReport {
      return Object.freeze({
        failures: Object.freeze(failures.slice()),
        omittedFailureCount,
      });
    },
  };
}
