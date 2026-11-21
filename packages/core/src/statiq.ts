import { hasFreshProvenance } from './provenance.js';
/**
 * Statiq API replica client.
 *
 * - Bearer token comes from the environment and is used ONLY here,
 *   server-side. It is never printed, logged, or included in error messages.
 * - MEMO POLICY: the in-memory details memo exists ONLY for reuse inside a
 *   single planning run (the same station can be examined twice within one
 *   plan). Callers must create a fresh client per planning run; memoized
 *   data must NEVER be presented as live status. Anything showing status
 *   carries a `fetchedAt` timestamp from `detailsWithMeta`.
 * - The rolling-window limiter spaces calls out (anti-burst) and hard-caps
 *   calls per 60s; it is abort-aware so a run deadline cancels cleanly.
 *   Its defaults (25 calls / 60s, 2s min gap) are CONSERVATIVE PROJECT
 *   SAFETY DEFAULTS - our own politeness choice, NOT a provider contract:
 *   the upstream publishes no rate-limit headers we rely on.
 * - RETRY POLICY: budgeted planning runs (see attachRunBudget) fail CLOSED
 *   on the FIRST 429/401/403 - the shared budget stops AT THE RESPONSE
 *   HEADERS, BEFORE the body resolves (a fatal status is fully known at
 *   headers; waiting for the body let a gated worker slip one extra
 *   dispatch - the Linux race repro), no sleep-then-retry, no NEW dispatch
 *   from any concurrent worker (requests already in flight complete as
 *   legitimate work), and the parsed Retry-After (delay-seconds OR
 *   HTTP-date) is recorded at stop time for honest reporting. Without a
 *   budget (single-call station revalidation) 429s are honored via the
 *   full Retry-After with capped retries.
 * - TIMEOUT vs CANCELLATION (completion-contract boundary): the per-request
 *   timeout (10s inner controller) is a RETRYABLE TRANSPORT FAILURE - it
 *   reached the wire, is audited with status 0, counts against the run
 *   budget (retries included) and is retried. Only OUTER signal aborts
 *   (run deadline / explicit cancellation) are run-fatal and never
 *   retried - detected by the authoritative signal state, not the error
 *   shape (an AbortError with a live outer signal is a timeout).
 */
import type {
  StatiqCardsResponse,
  StatiqDetailsResponse,
  StatiqCharger,
  StatiqConnector,
  StatiqMarker,
  StatiqMarkersResponse,
  StatiqStationDetail,
} from './types.js';
import { sleep as defaultSleep } from './utils.js';
import { UpstreamBudget, UpstreamRunStoppedError } from './upstream-budget.js';
import {
  parseGatewayContractData,
  parseGatewayContractReason,
  parseGatewayFailureCode,
  parseGatewayUpstreamStatus,
  statusCodeForHttp,
  transportCodeForCause,
  type ProviderCallContext,
  type ProviderFailureCode,
  type ProviderFailureCollector,
} from './provider-failure.js';

export const DEFAULT_STATIQ_BASE_URL =
  'https://harrier-evroute.aaravnirajsingh.workers.dev/api';
const TRUSTED_RAW_MARKERS_URL =
  'https://harrier-evroute.aaravnirajsingh.workers.dev/station/v1/markers';
const RAW_EMPTY_MESSAGE = 'No stations found with selected filters';
type MarkerVertex = readonly [number, number];
interface RawEmptyConfirmation {
  readonly lat: number;
  readonly lon: number;
  readonly vertices: readonly MarkerVertex[];
}
interface PostJsonOptions {
  readonly fetchUrl?: string;
  readonly rawEmptyConfirmation?: RawEmptyConfirmation;
  readonly rawEmptyCheck?: boolean;
}

/** Ordered corridor sample for one bulk marker batch. The client builds the
 *  exact closed square itself so the worker's echoed vertices are controlled. */
export interface BulkMarkerPoint {
  readonly lat: number;
  readonly lon: number;
}

/** Strictly validated per-item outcome from one bulk batch. `response` is
 *  present only for `ok`/`confirmed-empty`; every hole stays visible. */
export interface BulkItemResult<T> {
  readonly outcome: 'ok' | 'confirmed-empty' | 'unknown' | 'not-attempted';
  readonly reason: string | null;
  readonly upstream: { attempts: number; statuses: readonly (number | 'timeout' | 'network' | 'deadline')[]; fetchedAt: string | null };
  readonly response?: T;
}

type BulkEndpoint = 'markers-bulk' | 'details-bulk';
const BULK_MARKERS_PATH = '/stations/markers-bulk';
const BULK_DETAILS_PATH = '/stations/details-bulk';
const BULK_MARKER_UPSTREAM_PATH = '/station/v1/markers';
const BULK_DETAIL_UPSTREAM_PATH = '/station/v1/details';
const BULK_MARKERS_CHUNK = 12; // live verified at the worker hard cap
const BULK_DETAILS_CHUNK = 2;  // live verified bound (worker allows 25)
const BULK_DEADLINE_CAP_MS = 150_000;
/** Minimum worker work window: one paced upstream fetch (2s gap + up to 15s
 *  fetch timeout) plus scheduling headroom. Below this no batch is dispatched. */
const BULK_MIN_WORK_MS = 20_000;
/** Bounded margin for the worker's honest deadline envelope to be drained and
 *  parsed BEFORE the client transport abort fires. */
const BULK_DRAIN_MARGIN_MS = 5_000;

/** One batch lifecycle derived from the SINGLE authoritative outer deadline.
 *  `workerMs` is sent to the worker as its work window; `transportMs` is the
 *  client abort window = worker window + drain margin, never above the outer
 *  deadline. The worker therefore gets to answer with its honest deadline
 *  envelope before the client gives up. */
interface BulkBatchTiming {
  readonly workerMs: number;
  readonly transportMs: number;
}
const BULK_EMPTY_MESSAGE = 'No stations found with selected filters';
const BULK_OUTCOMES = new Set(['ok', 'confirmed-empty', 'unknown', 'not-attempted']);
const BULK_REASONS = new Set([
  'budget_exhausted', 'deadline', 'upstream_throttled', 'upstream_timeout',
  'upstream_error', 'upstream_auth', 'contract_invalid',
]);

/** Actual upstream status values: HTTP integers or the documented disposition
 *  markers. No synthesized integer is invented for a timeout/network/deadline. */
export type BulkStatus = number | 'timeout' | 'network' | 'deadline';
const BULK_STATUS_MARKERS = new Set(['timeout', 'network', 'deadline']);
function bulkStatus(value: unknown): value is BulkStatus {
  if (typeof value === 'string') return BULK_STATUS_MARKERS.has(value);
  return bulkInt(value) && (value as number) >= 0 && (value as number) <= 599;
}
function bulkStatusKey(value: BulkStatus): string {
  return typeof value === 'string' ? value : String(value);
}
interface BulkItemEcho {
  readonly key: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly vertices?: readonly MarkerVertex[];
  readonly stationId?: number;
}

function bulkInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}
function bulkJsonMediaType(value: unknown): boolean {
  return typeof value === 'string' && value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}
function bulkNoStore(value: unknown): boolean {
  return typeof value === 'string' &&
    value.split(',').some((part) => part.trim().toLowerCase() === 'no-store');
}
function bulkStamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function bulkFailureCode(outcome: string, reason: string | null, endpoint: BulkEndpoint): ProviderFailureCode {
  if (outcome === 'ok' || outcome === 'confirmed-empty') return 'unknown';
  switch (reason) {
    case 'budget_exhausted': return 'budget_exhausted';
    case 'deadline': return 'deadline';
    case 'upstream_throttled': return 'http_429';
    case 'upstream_timeout': return 'transport_timeout';
    case 'upstream_error': return 'transport_network';
    case 'upstream_auth': return 'fatal_auth';
    case 'contract_invalid':
      return endpoint === 'markers-bulk' ? 'invalid_marker_list' : 'invalid_details_shape';
    default: return 'unknown';
  }
}

interface BulkEnvelopeView {
  requestedItems: number;
  upstreamAttempts: number;
  items: readonly Record<string, unknown>[];
}

/** Strict whole-call + per-item validation. A partial envelope (ok:false)
 *  is valid: every item stays an independent honest outcome. Settlement is
 *  allowed only after ALL cross-checks below pass, so fake unused counts can
 *  never release a reservation. */
function parseBulkEnvelope(value: unknown, endpoint: BulkEndpoint, path: string): BulkEnvelopeView | null {
  if (!ownRecord(value)) return null;
  const ok = ownDataValue(value, 'ok');
  const live = ownDataValue(value, 'live');
  const retained = ownDataValue(value, 'retained');
  const ep = ownDataValue(value, 'endpoint');
  const startedAt = ownDataValue(value, 'startedAt');
  const completedAt = ownDataValue(value, 'completedAt');
  const deadline = ownDataValue(value, 'deadline');
  const requested = ownDataValue(value, 'requestedItems');
  const attempted = ownDataValue(value, 'attemptedItems');
  const completed = ownDataValue(value, 'completedItems');
  const attempts = ownDataValue(value, 'upstreamAttempts');
  const byStatus = ownDataValue(value, 'upstreamByStatus');
  const items = ownDataValue(value, 'items');
  if (typeof ok !== 'boolean' || live !== true || retained !== false || ep !== endpoint) return null;
  if (!bulkStamp(startedAt) || !bulkStamp(completedAt) ||
      Date.parse(completedAt as string) < Date.parse(startedAt as string)) return null;
  if (!ownRecord(deadline) || !bulkInt(ownDataValue(deadline, 'ms')) ||
      (ownDataValue(deadline, 'ms') as number) <= 0 ||
      typeof ownDataValue(deadline, 'hit') !== 'boolean') return null;
  if (!bulkInt(requested) || !bulkInt(attempted) || !bulkInt(completed) || !bulkInt(attempts) ||
      (attempts as number) < 0 || (attempted as number) < 0 || (completed as number) < 0) return null;
  if (!ownRecord(byStatus)) return null;
  const declaredHistogram = new Map<string, number>();
  let declaredStatusSum = 0;
  for (const key of Object.keys(byStatus)) {
    const numericKey = Number(key);
    const validKey = BULK_STATUS_MARKERS.has(key) ||
      (bulkInt(numericKey) && numericKey >= 0 && numericKey <= 599 && String(numericKey) === key);
    const count = ownDataValue(byStatus, key);
    if (!validKey || !bulkInt(count) || (count as number) < 0) return null;
    declaredHistogram.set(key, count as number);
    declaredStatusSum += count as number;
  }
  if (declaredStatusSum !== attempts) return null;
  if (!Array.isArray(items) || items.length !== requested) return null;

  let attemptedCount = 0;
  let completedCount = 0;
  let itemAttemptSum = 0;
  const observedHistogram = new Map<string, number>();
  for (const item of items) {
    if (!ownRecord(item)) return null;
    const outcome = ownDataValue(item, 'outcome');
    const reason = ownDataValue(item, 'reason');
    const upstream = ownDataValue(item, 'upstream');
    const provenance = ownDataValue(item, 'provenance');
    const data = ownDataValue(item, 'data');
    if (typeof outcome !== 'string' || !BULK_OUTCOMES.has(outcome)) return null;
    if (reason !== null && !(typeof reason === 'string' && BULK_REASONS.has(reason))) return null;
    if (!ownRecord(upstream)) return null;
    const attemptsForItem = ownDataValue(upstream, 'attempts');
    const statuses = ownDataValue(upstream, 'statuses');
    const fetchedAt = ownDataValue(upstream, 'fetchedAt');
    if (!bulkInt(attemptsForItem) || (attemptsForItem as number) < 0 || (attemptsForItem as number) > 1 ||
        !Array.isArray(statuses) || statuses.length !== attemptsForItem) return null;
    for (const status of statuses) {
      if (!bulkStatus(status)) return null;
      const key = bulkStatusKey(status);
      observedHistogram.set(key, (observedHistogram.get(key) ?? 0) + 1);
    }
    if (attemptsForItem === 0) {
      if (statuses.length !== 0 || fetchedAt !== null || provenance !== null || reason === null) return null;
    } else {
      attemptedCount++;
      itemAttemptSum += attemptsForItem as number;
      if (!bulkStamp(fetchedAt)) return null;
      if (provenance !== null && !ownRecord(provenance)) return null;
    }
    if (outcome === 'ok' || outcome === 'confirmed-empty') {
      if (reason !== null || attemptsForItem !== 1 || statuses.length !== 1 || statuses[0] !== 200 ||
          !ownRecord(provenance) ||
          ownDataValue(provenance, 'sourceUrlPath') !== path ||
          ownDataValue(provenance, 'httpStatus') !== 200 ||
          !bulkJsonMediaType(ownDataValue(provenance, 'contentType')) ||
          !(ownDataValue(provenance, 'cacheControl') === null ||
            typeof ownDataValue(provenance, 'cacheControl') === 'string')) return null;
      completedCount++;
    } else if (data !== null) {
      // UNKNOWN / not-attempted never carry success data.
      return null;
    }
    if (outcome === 'not-attempted' && attemptsForItem !== 0) return null;
    if (outcome === 'unknown' && attemptsForItem === 0) return null;
    if (outcome === 'confirmed-empty') {
      const confirmation = ownDataValue(item, 'confirmation');
      if (data !== null || !ownRecord(confirmation) ||
          path !== BULK_MARKER_UPSTREAM_PATH ||
          ownDataValue(confirmation, 'sourceUrlPath') !== BULK_MARKER_UPSTREAM_PATH ||
          ownDataValue(confirmation, 'httpStatus') !== 200 ||
          !bulkJsonMediaType(ownDataValue(confirmation, 'contentType')) ||
          ownDataValue(confirmation, 'fetchedAt') !== fetchedAt ||
          ownDataValue(confirmation, 'statusCode') !== 1001 ||
          ownDataValue(confirmation, 'success') !== false ||
          ownDataValue(confirmation, 'message') !== BULK_EMPTY_MESSAGE ||
          ownDataValue(confirmation, 'stationsCount') !== 0) return null;
    }
  }
  // Aggregates, per-item attempt sum and the exact status histogram must agree
  // before any reservation is settled.
  if (itemAttemptSum !== attempts || attemptedCount !== attempted || completedCount !== completed) return null;
  if (ok !== (completedCount === requested)) return null;
  if (observedHistogram.size !== declaredHistogram.size) return null;
  for (const [key, count] of observedHistogram) {
    if (declaredHistogram.get(key) !== count) return null;
  }
  return {
    requestedItems: requested as number,
    upstreamAttempts: attempts as number,
    items: items as readonly Record<string, unknown>[],
  };
}

function markerResponseFromBulkData(data: unknown): StatiqMarkersResponse | null {
  if (!ownRecord(data) || !hasFreshProvenance(data)) return null;
  if (ownDataValue(data, 'live') === false || ownDataValue(data, 'retained') === true) return null;
  if (ownDataValue(data, 'source') !== 'Statiq station markers (live)') return null;
  const raw = ownDataValue(data, 'stations');
  const declaredCount = ownDataValue(data, 'count');
  if (!Array.isArray(raw) || !bulkInt(declaredCount) || declaredCount !== raw.length) return null;
  // Ordinary ok with an empty list is NOT the strict raw-confirmed-empty proof.
  // Only a confirmed-empty item may claim zero stations (see build callback).
  if (raw.length === 0) return null;
  const stations: StatiqMarker[] = [];
  for (const value of raw) {
    if (!ownRecord(value) || !hasFreshProvenance(value)) return null;
    if (ownDataValue(value, 'live') === false || ownDataValue(value, 'retained') === true) return null;
    const stationId = ownDataValue(value, 'stationId');
    const name = ownDataValue(value, 'name');
    const lat = ownDataValue(value, 'lat');
    const lon = ownDataValue(value, 'lon');
    if (!(bulkInt(stationId) && Number.isSafeInteger(stationId) && (stationId as number) > 0) ||
        typeof name !== 'string' ||
        typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90 ||
        typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) return null;
    const address = ownDataValue(value, 'address');
    const accessType = ownDataValue(value, 'accessType');
    const stationUrl = ownDataValue(value, 'stationUrl');
    if ((address !== undefined && address !== null && typeof address !== 'string') ||
        (accessType !== undefined && accessType !== null && !bulkInt(accessType)) ||
        (stationUrl !== undefined && stationUrl !== null && typeof stationUrl !== 'string')) return null;
    stations.push({
      stationId: stationId as number, name, lat, lon,
      address: address === undefined || address === null ? null : address as string,
      accessType: accessType === undefined || accessType === null ? 0 : accessType as number,
      isCommunityListed: ownDataValue(value, 'isCommunityListed') === true,
      stationUrl: stationUrl === undefined || stationUrl === null ? '' : stationUrl as string,
    });
  }
  return {
    ok: true,
    live: true,
    retained: false,
    source: 'Statiq station markers (live)',
    count: stations.length,
    stations,
  };
}

function emptyMarkersFromBulk(): StatiqMarkersResponse {
  return { ok: true, live: true, retained: false, source: 'raw-confirmed-empty', count: 0, stations: [] };
}

function strictText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : null;
}
function strictOptionalNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function strictTextOrEmpty(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : '';
}
function safePositive(value: unknown): number | null {
  return bulkInt(value) && (value as number) > 0 && Number.isSafeInteger(value) ? value as number : null;
}
function safeNonNegative(value: unknown): number | null {
  return bulkInt(value) && (value as number) >= 0 && Number.isSafeInteger(value) ? value as number : null;
}

/** Rebuild the worker-normalized detail with NO coercion. Malformed identity,
 *  charger/connector power, tariff, health or type fails the item closed
 *  (unknown); absent optional fields remain null. */
function stationDetailFromBulk(value: unknown): StatiqStationDetail | null {
  if (!ownRecord(value)) return null;
  const stationId = safePositive(ownDataValue(value, 'stationId'));
  const name = ownDataValue(value, 'name');
  const lat = ownDataValue(value, 'lat');
  const lon = ownDataValue(value, 'lon');
  if (stationId === null || typeof name !== 'string' ||
      typeof lat !== 'number' || !Number.isFinite(lat) ||
      typeof lon !== 'number' || !Number.isFinite(lon)) return null;
  const chargersRaw = ownDataValue(value, 'chargers');
  if (!Array.isArray(chargersRaw)) return null;
  const chargers: StatiqCharger[] = [];
  for (const chargerValue of chargersRaw) {
    if (!ownRecord(chargerValue)) return null;
    const chargerId = safePositive(ownDataValue(chargerValue, 'chargerId'));
    const chargerName = ownDataValue(chargerValue, 'name');
    const chargerType = ownDataValue(chargerValue, 'type');
    const kw = ownDataValue(chargerValue, 'kw');
    if (chargerId === null || typeof chargerName !== 'string' || typeof chargerType !== 'string' ||
        typeof kw !== 'number' || !Number.isFinite(kw)) return null;
    const priceRaw = ownDataValue(chargerValue, 'pricePerKwh');
    if (priceRaw !== undefined && priceRaw !== null &&
        (typeof priceRaw !== 'number' || !Number.isFinite(priceRaw))) return null;
    const connectorsRaw = ownDataValue(chargerValue, 'connectors');
    if (!Array.isArray(connectorsRaw)) return null;
    const connectors: StatiqConnector[] = [];
    for (const connValue of connectorsRaw) {
      if (!ownRecord(connValue)) return null;
      const displayId = safeNonNegative(ownDataValue(connValue, 'displayId'));
      const connectorId = safeNonNegative(ownDataValue(connValue, 'connectorId'));
      const type = ownDataValue(connValue, 'type');
      const status = ownDataValue(connValue, 'status');
      const availableRaw = ownDataValue(connValue, 'available');
      const noteRaw = ownDataValue(connValue, 'note');
      if (displayId === null || connectorId === null ||
          typeof type !== 'string' || typeof status !== 'string' ||
          (availableRaw !== undefined && availableRaw !== null && typeof availableRaw !== 'boolean') ||
          (noteRaw !== undefined && noteRaw !== null && typeof noteRaw !== 'string')) return null;
      connectors.push({
        displayId, connectorId, type, status,
        available: availableRaw === undefined || availableRaw === null ? null : availableRaw,
        note: noteRaw === undefined || noteRaw === null ? null : noteRaw,
      });
    }
    const currencyRaw = ownDataValue(chargerValue, 'currency');
    const lastUsedRaw = ownDataValue(chargerValue, 'lastUsedOn');
    if ((currencyRaw !== undefined && currencyRaw !== null && typeof currencyRaw !== 'string') ||
        (lastUsedRaw !== undefined && lastUsedRaw !== null && typeof lastUsedRaw !== 'string')) return null;
    chargers.push({
      chargerId, name: chargerName, type: chargerType, kw,
      pricePerKwh: priceRaw === undefined ? null : priceRaw,
      currency: currencyRaw === undefined ? null : currencyRaw,
      lastUsedOn: lastUsedRaw === undefined ? null : lastUsedRaw,
      connectors,
    });
  }
  const amenitiesRaw = ownDataValue(value, 'amenities');
  if (amenitiesRaw !== undefined && amenitiesRaw !== null &&
      (!Array.isArray(amenitiesRaw) || amenitiesRaw.some((a) => typeof a !== 'string'))) return null;
  const summaryRaw = ownDataValue(value, 'summary');
  let summary: StatiqStationDetail['summary'] = null;
  if (summaryRaw !== undefined && summaryRaw !== null) {
    if (!ownRecord(summaryRaw)) return null;
    const anyDc = ownDataValue(summaryRaw, 'anyDc');
    const ccs2Dc = ownDataValue(summaryRaw, 'ccs2Dc');
    const availableNow = ownDataValue(summaryRaw, 'availableNow');
    const maxKw = strictOptionalNumber(ownDataValue(summaryRaw, 'maxDcCcs2Kw'));
    const counts = ownDataValue(summaryRaw, 'statusCounts');
    if (typeof anyDc !== 'boolean' || typeof ccs2Dc !== 'boolean' ||
        typeof availableNow !== 'boolean' || !ownRecord(counts)) return null;
    const statusCounts: Record<string, number> = {};
    for (const key of Object.keys(counts)) {
      const n = ownDataValue(counts, key);
      if (!bulkInt(n) || (n as number) < 0) return null;
      statusCounts[key] = n as number;
    }
    summary = { anyDc, ccs2Dc, maxDcCcs2Kw: maxKw, availableNow, statusCounts };
  }
  const nullable = (key: string): string | null => strictText(ownDataValue(value, key));
  const navUrl = ownDataValue(value, 'navUrl');
  const stationUrl = ownDataValue(value, 'stationUrl');
  if ((navUrl !== undefined && navUrl !== null && typeof navUrl !== 'string') ||
      (stationUrl !== undefined && stationUrl !== null && typeof stationUrl !== 'string')) return null;
  return {
    stationId, name, lat, lon,
    address: nullable('address'), area: nullable('area'), city: nullable('city'),
    landmark: nullable('landmark'), hours: nullable('hours'), openText: nullable('openText'),
    rating: strictOptionalNumber(ownDataValue(value, 'rating')),
    reviewCount: strictOptionalNumber(ownDataValue(value, 'reviewCount')),
    accessType: nullable('accessType'),
    navUrl: strictTextOrEmpty(navUrl), stationUrl: strictTextOrEmpty(stationUrl),
    imageUrl: nullable('imageUrl'),
    amenities: Array.isArray(amenitiesRaw) ? amenitiesRaw.filter((a): a is string => typeof a === 'string') : [],
    stepsToReach: nullable('stepsToReach'),
    chargers,
    summary,
  };
}

function markerSquareVertices(lat: number, lon: number): MarkerVertex[] {
  const west = lon - 0.1, east = lon + 0.1, south = lat - 0.1, north = lat + 0.1;
  return [[west, south], [east, south], [east, north], [west, north], [west, south]];
}
function ownDataValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function ownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function confirmedRawEmpty(res: Response, parsed: unknown): boolean {
  if (res.status !== 200 || !hasFreshProvenance(parsed)) return false;
  const contentType = res.headers?.get('content-type');
  const isJson = typeof contentType === 'string' &&
    contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
  const cacheControl = res.headers?.get('cache-control');
  const noStore = typeof cacheControl === 'string' &&
    cacheControl.split(',').map(part => part.trim().toLowerCase()).includes('no-store');
  if (!isJson || !noStore || res.headers?.get('x-evroute-upstream') !== 'statiq-live') return false;
  const meta = ownDataValue(parsed, 'meta');
  const data = ownDataValue(parsed, 'data');
  const stations = ownDataValue(data, 'stations');
  return ownRecord(meta) && ownDataValue(meta, 'status_code') === 1001 &&
    ownDataValue(meta, 'success') === false &&
    ownDataValue(meta, 'message') === RAW_EMPTY_MESSAGE &&
    ownRecord(data) && Array.isArray(stations) && stations.length === 0;
}

/**
 * How long dispatch stamps are retained by the rolling-window limiter
 * (slightly past the 60s window so boundary windows stay conservative).
 * SHARED with the work-estimate module (packages/core/src/work-estimate.ts)
 * so the limiter's effective sustained pacing and full-coverage estimates
 * can never drift apart. Linux measured the effective window at ~62.05s
 * (25 calls per 62.05s under the defaults).
 */
export const WINDOW_RETENTION_MS = 62_000;

export class StatiqApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
    readonly retryAfterMs?: number,
  ) {
    // Body text is upstream-controlled JSON; keep it short and never
    // include request headers (token safety).
    super(`Statiq API ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = 'StatiqApiError';
  }
}

export class StatiqProvenanceError extends StatiqApiError {
  constructor(path: string) {
    super(200, path, 'Fresh station provenance could not be verified');
    this.name = 'StatiqProvenanceError';
  }
}

/**
 * Run-fatal 4xx under an attached run budget (first 429/401/403).
 * Never retried; the whole planning run fails closed (the planner maps
 * this to an honest not_determined outcome with coverage evidence).
 */
export class StatiqRunFatalError extends StatiqApiError {
  constructor(
    readonly stopCause: 'throttled' | 'auth',
    status: number,
    path: string,
    body: string,
    retryAfterMs?: number,
  ) {
    super(status, path, body, retryAfterMs);
    this.name = 'StatiqRunFatalError';
  }
}

/** Raised when a call is aborted (run deadline/budget reached). Never retried. */
export class StatiqAbortError extends Error {
  constructor(message = 'Statiq call aborted (run deadline or cancellation)') {
    super(message);
    this.name = 'StatiqAbortError';
  }
}

/** True for any abort-shaped error (ours, fetch's, or DOMException). */
export function isAbortLike(err: unknown): boolean {
  return (
    err instanceof StatiqAbortError ||
    (err instanceof Error && err.name === 'AbortError') ||
    (err instanceof Error && /aborted/i.test(err.message))
  );
}

export interface StatiqClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** in-memory details cache TTL; 0 disables caching */
  cacheTtlMs?: number;
  timeoutMs?: number;
  retries?: number;
  /**
   * Rolling-window limit: max upstream calls per 60s. Default 25 is a
   * CONSERVATIVE PROJECT SAFETY DEFAULT, NOT a provider contract (the
   * upstream publishes no rate headers we rely on). Smoothed by
   * minCallGapMs below, so the budget cannot burst.
   */
  maxCallsPerMinute?: number;
  /**
   * Minimum gap between upstream calls. Default 2000ms is likewise a
   * PROJECT SAFETY DEFAULT, NOT a provider contract.
   */
  minCallGapMs?: number;
  /** Injectable clock for deterministic limiter tests. */
  now?: () => number;
  /** Injectable sleep for deterministic limiter tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Wall-clock deadline (ms epoch) for the planning run this client serves.
   * If a 429's Retry-After cannot fit before this deadline, the call fails
   * fast with the throttled error instead of retrying early.
   */
  /**
   * Sanitized audit observer: invoked once per upstream attempt with
   * { seq, endpoint, status, at } ONLY. Never auth headers, query strings,
   * request/response bodies, coordinates or any private route data.
   */
  onUpstreamCall?: (entry: UpstreamAuditEntry) => void;
  runDeadlineAt?: number;
}

/** Strictly sanitized audit entry: endpoint name + status + time + count. */
export interface UpstreamAuditEntry {
  /** Running count of upstream attempts within this client (planning run). */
  seq: number;
  /** Endpoint path only, e.g. "stations/markers". */
  endpoint: string;
  /** HTTP status (0 = transport failure / abort). */
  status: number;
  /** ISO timestamp. */
  at: string;
}

interface CacheEntry {
  at: number;
  response: StatiqDetailsResponse;
  fetchedAt: Date;
}

export interface StationDetailsWithMeta {
  response: StatiqDetailsResponse;
  /** When this upstream response was actually fetched. */
  fetchedAt: Date;
}

export class StatiqClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxCallsPerMinute: number;
  private readonly minCallGapMs: number;
  private readonly now: () => number;
  private readonly doSleep: (ms: number) => Promise<void>;
  private readonly runDeadlineAt: number | undefined;
  private readonly onUpstreamCall: ((entry: UpstreamAuditEntry) => void) | undefined;
  /** Per-run bounded completion evidence; never an execution controller. */
  private failureCollector: ProviderFailureCollector | undefined;
  /** Separate from completion-order audit seq; incremented at dispatch. */
  private dispatchAttempts = 0;
  /** Shared per-run attempt budget (attached by the planner for live runs). */
  private runBudget: UpstreamBudget | undefined;
  private upstreamAttempts = 0;
  private readonly detailsCache = new Map<number, CacheEntry>();
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private callStamps: number[] = [];
  /** Serializes slot acquisition so concurrent callers cannot interleave. */
  private slotQueue: Promise<void> = Promise.resolve();
  /** One active bulk batch; legacy dispatch is refused while it is set. */
  private bulkInFlight = false;
  /** Once a bulk transport/contract state is unknown, every later bulk or
   *  legacy dispatch fails closed with the same error - no retry, no fallback. */
  private bulkFailureLatch: Error | null = null;

  constructor(opts: StatiqClientOptions) {
    if (!opts.token) {
      throw new Error('StatiqClient requires a token (set STATIQ_API_TOKEN)');
    }
    this.base = (opts.baseUrl ?? DEFAULT_STATIQ_BASE_URL).replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cacheTtlMs = opts.cacheTtlMs ?? 90_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
    this.maxCallsPerMinute = opts.maxCallsPerMinute ?? 25;
    this.minCallGapMs = opts.minCallGapMs ?? 2_000;
    this.now = opts.now ?? Date.now;
    this.doSleep = opts.sleepImpl ?? defaultSleep;
    this.runDeadlineAt = opts.runDeadlineAt;
    this.onUpstreamCall = opts.onUpstreamCall;
  }

  /** Stations near a point (~13 km radius, capped at 256 by the upstream). */
  markers(
    lat: number,
    lon: number,
    signal?: AbortSignal,
    context?: ProviderCallContext,
  ): Promise<StatiqMarkersResponse> {
    const vertices = markerSquareVertices(lat, lon);
    const rawEmptyConfirmation = this.base === DEFAULT_STATIQ_BASE_URL ? { lat, lon, vertices } : undefined;
    return this.postJson<StatiqMarkersResponse>(
      '/stations/markers',
      { latitude: lat, longitude: lon, vertices },
      signal,
      context,
      { rawEmptyConfirmation },
    );
  }

  /** Nearest station cards around a point. */
  cards(lat: number, lon: number, signal?: AbortSignal): Promise<StatiqCardsResponse> {
    return this.postJson('/stations/cards', { latitude: lat, longitude: lon }, signal);
  }

  /**
   * Full details with a fetched-at timestamp. The memo returns the original
   * fetch time (not access time) so status displays stay honest.
   */
  async detailsWithMeta(
    stationId: number,
    signal?: AbortSignal,
    context?: ProviderCallContext,
  ): Promise<StationDetailsWithMeta> {
    if (signal?.aborted) throw new StatiqAbortError();
    const cached = this.detailsCache.get(stationId);
    if (cached && this.now() - cached.at < this.cacheTtlMs) {
      if (!hasFreshProvenance(cached.response)) throw new StatiqProvenanceError('/stations/details');
      if (signal?.aborted) throw new StatiqAbortError();
      return { response: cached.response, fetchedAt: cached.fetchedAt };
    }
    const response = await this.postJson<StatiqDetailsResponse>('/stations/details', {
      station_id: stationId,
    }, signal, context);
    if (signal?.aborted) throw new StatiqAbortError();
    if (!hasFreshProvenance(response)) throw new StatiqProvenanceError('/stations/details');
    const fetchedAt = new Date();
    if (response && response.station) {
      const at = this.now();
      if (signal?.aborted) throw new StatiqAbortError();
      this.detailsCache.set(stationId, { at, response, fetchedAt });
    }
    return { response, fetchedAt };
  }

  /** Wire-shaped details (no fetch metadata). */
  async details(stationId: number, signal?: AbortSignal): Promise<StatiqDetailsResponse> {
    const result = await this.detailsWithMeta(stationId, signal);
    if (signal?.aborted) throw new StatiqAbortError();
    return result.response;
  }

  /**
   * BULK TRANSPORT (owner-deployed additive endpoints). Strictly validated,
   * pessimistically budget-reserved, one active batch at a time. The worker
   * reproduces the same 25/62s + 2s pacing server-side; the client does NOT
   * re-pace batches. One client HTTP envelope may cover many upstream fetches.
   */
  /** Derive worker work window and client transport window TOGETHER from the
   *  absolute outer run deadline. Null => not enough room for a safe batch. */
  private bulkBatchTiming(): BulkBatchTiming | null {
    const absoluteRemaining = this.runDeadlineAt != null
      ? this.runDeadlineAt - this.now()
      : BULK_DEADLINE_CAP_MS;
    if (absoluteRemaining < BULK_MIN_WORK_MS + BULK_DRAIN_MARGIN_MS) return null;
    const workerMs = Math.max(BULK_MIN_WORK_MS, Math.min(
      BULK_DEADLINE_CAP_MS - BULK_DRAIN_MARGIN_MS,
      absoluteRemaining - BULK_DRAIN_MARGIN_MS,
    ));
    const transportMs = Math.min(absoluteRemaining, workerMs + BULK_DRAIN_MARGIN_MS);
    return { workerMs, transportMs };
  }

  private auditBulkItem(endpoint: string, status: BulkStatus): void {
    this.upstreamAttempts += 1;
    if (this.onUpstreamCall) {
      this.onUpstreamCall({
        seq: this.upstreamAttempts,
        endpoint: endpoint.replace(/^\/+/, ''),
        // Transport dispositions are audited as status 0 (the documented
        // transport-failure code), never as a fabricated HTTP status.
        status: typeof status === 'number' ? status : 0,
        at: new Date().toISOString(),
      });
    }
  }

  private async bulkFetch<T>(
    path: string,
    endpoint: BulkEndpoint,
    upstreamPath: string,
    payload: unknown,
    reserved: number,
    echoes: readonly BulkItemEcho[],
    ordinalBase: number,
    transportMs: number,
    signal: AbortSignal | undefined,
    context: ProviderCallContext | undefined,
    build: (item: Record<string, unknown>) => T | null,
  ): Promise<BulkItemResult<T>[]> {
    if (this.bulkFailureLatch) throw this.bulkFailureLatch;
    if (this.bulkInFlight) throw new StatiqAbortError('a bulk batch is already active');
    const budget = this.runBudget;
    if (!budget) throw new Error('Bulk transport requires an attached run budget');
    if (!signal?.aborted) this.bulkInFlight = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      if (signal?.aborted) throw new StatiqAbortError();
      budget.reserveBatch(reserved);
      const seqBase = this.dispatchAttempts;
      // Single authoritative lifecycle: transport window = worker work
      // window + drain margin; the worker can return its honest deadline
      // envelope before this abort can race it out.
      timer = setTimeout(() => controller.abort(), transportMs);
      const res = await this.fetchImpl(this.base + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      // The single client HTTP envelope is NOT an upstream attempt: actual
      // attempts are audited below from the VERIFIED per-item statuses only.
      if (signal?.aborted) throw new StatiqAbortError();
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        const cause = res.status === 429 ? 'throttled' : 'auth';
        const retryAfter = cause === 'throttled'
          ? this.parseRetryAfterMs(res.headers?.get('retry-after'))
          : undefined;
        // Whole-call auth/throttle is a real wire status; never report it
        // as status 0 or an invented dispatch sequence.
        this.reportFailure(context, path,
          cause === 'throttled' ? 'fatal_throttled' : 'fatal_auth', null, res.status);
        budget.stop(cause, retryAfter);
        throw new StatiqRunFatalError(cause, res.status, path, '', retryAfter);
      }
      const text = await res.text();
      if (signal?.aborted) throw new StatiqAbortError();
      // Unsupported-path 404 is NOT safely verifiable from the deployed
      // contract artifacts: insufficient evidence means no legacy fallback.
      if (!res.ok) throw new StatiqApiError(res.status, path, text);
      if (!bulkJsonMediaType(res.headers?.get('content-type')) ||
          !bulkNoStore(res.headers?.get('cache-control')) ||
          res.headers?.get('x-evroute-upstream') !== 'statiq-live') {
        throw new StatiqProvenanceError(path);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new StatiqProvenanceError(path); }
      const envelope = parseBulkEnvelope(parsed, endpoint, upstreamPath);
      if (!envelope || envelope.upstreamAttempts > reserved ||
          envelope.requestedItems !== echoes.length) {
        throw new StatiqProvenanceError(path);
      }
      // PHASE 1: validate and build EVERY item/echo/identity into a local
      // staging area. NO counter, audit, evidence record or budget mutation
      // happens here: one bad late item must leave an entirely untouched
      // accounting state, never partial audits with a full held reservation.
      const results: BulkItemResult<T>[] = [];
      const stagedAudits: BulkStatus[] = [];
      interface StagedFailure {
        ctx: ProviderCallContext;
        code: ProviderFailureCode;
        dispatchSeq: number | null;
        httpStatus: number | null;
      }
      const stagedFailures: StagedFailure[] = [];
      for (let i = 0; i < envelope.items.length; i++) {
        const item = envelope.items[i] as Record<string, unknown>;
        const echo = echoes[i] as BulkItemEcho;
        if (!this.bulkEchoMatches(item, echo)) throw new StatiqProvenanceError(path);
        const outcome = ownDataValue(item, 'outcome') as BulkItemResult<T>['outcome'];
        const reason = ownDataValue(item, 'reason') as string | null;
        const up = ownDataValue(item, 'upstream') as Record<string, unknown>;
        const upstream: BulkItemResult<T>['upstream'] = {
          attempts: ownDataValue(up, 'attempts') as number,
          statuses: ownDataValue(up, 'statuses') as BulkStatus[],
          fetchedAt: ownDataValue(up, 'fetchedAt') as string | null,
        };
        const built = outcome === 'ok' || outcome === 'confirmed-empty' ? build(item) : null;
        if ((outcome === 'ok' || outcome === 'confirmed-empty') && built == null) {
          throw new StatiqProvenanceError(path);
        }
        results.push({ outcome, reason, upstream, ...(built != null ? { response: built } : {}) });
        if (upstream.attempts > 0) stagedAudits.push(...upstream.statuses);
        if (outcome !== 'ok' && outcome !== 'confirmed-empty') {
          const provenanceStatus = ownDataValue(ownDataValue(item, 'provenance'), 'httpStatus');
          stagedFailures.push({
            ctx: {
              endpointClass: context?.endpointClass ?? 'none',
              phase: context?.phase ?? 'scan',
              sampleOrdinal: endpoint === 'markers-bulk' ? ordinalBase + i + 1 : null,
            },
            code: bulkFailureCode(outcome, reason, endpoint),
            // No fabricated dispatch seq for an item that dispatched nothing.
            dispatchSeq: upstream.attempts > 0 ? seqBase + i + 1 : null,
            httpStatus: typeof provenanceStatus === 'number' ? provenanceStatus : null,
          });
        }
      }
      // PHASE 2: the whole envelope is verified; reconcile atomically. Audit
      // seq, dispatch count and reservation settlement all move together.
      this.dispatchAttempts += envelope.upstreamAttempts;
      for (const status of stagedAudits) this.auditBulkItem(upstreamPath, status);
      for (const failure of stagedFailures) {
        this.reportFailure(failure.ctx, path, failure.code, failure.dispatchSeq, failure.httpStatus);
      }
      try { context?.onDispatch?.(seqBase + envelope.upstreamAttempts); } catch { /* evidence only */ }
      budget.settleBatch(reserved, envelope.upstreamAttempts);
      return results;
    } catch (err) {
      // Unknown transport/contract state latches the run closed: no retry,
      // no legacy resubmission, no follow-on batch, no concurrent dispatch.
      this.bulkFailureLatch = err instanceof Error ? err : new Error('bulk transport failed');
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
      this.bulkInFlight = false;
    }
  }

  private bulkEchoMatches(item: Record<string, unknown>, echo: BulkItemEcho): boolean {
    if (ownDataValue(item, 'key') !== echo.key) return false;
    if (echo.latitude !== undefined && ownDataValue(item, 'latitude') !== echo.latitude) return false;
    if (echo.longitude !== undefined && ownDataValue(item, 'longitude') !== echo.longitude) return false;
    if (echo.vertices !== undefined) {
      const value = ownDataValue(item, 'vertices');
      if (!Array.isArray(value) || value.length !== echo.vertices.length) return false;
      for (let i = 0; i < echo.vertices.length; i++) {
        const pair = value[i];
        if (!Array.isArray(pair) || pair.length !== 2 ||
            pair[0] !== echo.vertices[i]![0] || pair[1] !== echo.vertices[i]![1]) return false;
      }
    }
    if (echo.stationId !== undefined &&
        !(bulkInt(ownDataValue(item, 'stationId')) && Number.isSafeInteger(ownDataValue(item, 'stationId')) &&
          (ownDataValue(item, 'stationId') as number) > 0 && ownDataValue(item, 'stationId') === echo.stationId)) {
      return false;
    }
    return true;
  }

  /** Fetch every corridor sample in ordered bulk batches (12 max per call).
   *  `onItem` fires as each batch resolves so completed early batches survive
   *  a later fatal stop; sample ordinals are global, never per-batch. */
  async markersBulk(
    points: readonly BulkMarkerPoint[],
    signal?: AbortSignal,
    context?: ProviderCallContext,
    onItem?: (result: BulkItemResult<StatiqMarkersResponse>, index: number) => void,
  ): Promise<BulkItemResult<StatiqMarkersResponse>[]> {
    const results: BulkItemResult<StatiqMarkersResponse>[] = [];
    for (let i = 0; i < points.length; i += BULK_MARKERS_CHUNK) {
      const slice = points.slice(i, i + BULK_MARKERS_CHUNK);
      const squares = slice.map((p, j) => ({
        key: `s${i + j}`,
        latitude: p.lat,
        longitude: p.lon,
        vertices: markerSquareVertices(p.lat, p.lon),
      }));
      const reserved = Math.min(slice.length,
        (this.runBudget?.maxAttempts ?? 0) - (this.runBudget?.attemptsMade ?? 0));
      if (reserved < 1) {
        throw new UpstreamRunStoppedError('budget-exhausted',
          this.runBudget?.attemptsMade ?? 0, this.runBudget?.maxAttempts ?? 0);
      }
      const timing = this.bulkBatchTiming();
      if (!timing) throw new StatiqAbortError('insufficient remaining deadline for a safe bulk batch');
      const items = await this.bulkFetch<StatiqMarkersResponse>(
        BULK_MARKERS_PATH,
        'markers-bulk',
        BULK_MARKER_UPSTREAM_PATH,
        { squares, budget: { maxUpstreamAttempts: reserved }, deadlineMs: timing.workerMs },
        reserved,
        squares.map((s, j) => ({
          key: s.key, latitude: slice[j]!.lat, longitude: slice[j]!.lon, vertices: s.vertices,
        })),
        i,
        timing.transportMs,
        signal,
        context,
        (item) => ownDataValue(item, 'outcome') === 'confirmed-empty'
          ? emptyMarkersFromBulk()
          : markerResponseFromBulkData(ownDataValue(item, 'data')),
      );
      let stopCause: 'throttled' | 'auth' | undefined;
      for (let j = 0; j < items.length; j++) {
        const item = items[j] as BulkItemResult<StatiqMarkersResponse>;
        results.push(item);
        try { onItem?.(item, i + j); } catch { /* progress evidence never alters policy */ }
        if (item.outcome === 'unknown' &&
            (item.reason === 'upstream_auth' || item.reason === 'upstream_throttled')) {
          stopCause = item.reason === 'upstream_auth' ? 'auth' : 'throttled';
        }
      }
      // Per-item upstream auth/throttle stops ALL later dispatches.
      if (stopCause) {
        this.runBudget?.stop(stopCause);
        throw new StatiqRunFatalError(stopCause, 0, BULK_MARKERS_PATH, 'per-item upstream fatal');
      }
    }
    return results;
  }

  /** Fetch details for every unique station in ordered bulk batches. */
  async detailsBulk(
    stationIds: readonly number[],
    signal?: AbortSignal,
    context?: ProviderCallContext,
    onItem?: (result: BulkItemResult<StationDetailsWithMeta>, index: number) => void,
  ): Promise<BulkItemResult<StationDetailsWithMeta>[]> {
    const results: BulkItemResult<StationDetailsWithMeta>[] = [];
    for (let i = 0; i < stationIds.length; i += BULK_DETAILS_CHUNK) {
      const slice = stationIds.slice(i, i + BULK_DETAILS_CHUNK);
      const stations = slice.map((id, j) => ({ key: `d${i + j}`, stationId: id }));
      const reserved = Math.min(slice.length,
        (this.runBudget?.maxAttempts ?? 0) - (this.runBudget?.attemptsMade ?? 0));
      if (reserved < 1) {
        throw new UpstreamRunStoppedError('budget-exhausted',
          this.runBudget?.attemptsMade ?? 0, this.runBudget?.maxAttempts ?? 0);
      }
      const timing = this.bulkBatchTiming();
      if (!timing) throw new StatiqAbortError('insufficient remaining deadline for a safe bulk batch');
      const items = await this.bulkFetch<StationDetailsWithMeta>(
        BULK_DETAILS_PATH,
        'details-bulk',
        BULK_DETAIL_UPSTREAM_PATH,
        { stations, budget: { maxUpstreamAttempts: reserved }, deadlineMs: timing.workerMs },
        reserved,
        stations.map((s, j) => ({ key: s.key, stationId: slice[j]! })),
        0,
        timing.transportMs,
        signal,
        context,
        (item) => {
          const station = ownDataValue(ownDataValue(item, 'data'), 'station');
          const stationDetail = stationDetailFromBulk(station);
          if (!stationDetail || stationDetail.stationId !== ownDataValue(item, 'stationId')) return null;
          const fetchedAt = ownDataValue(ownDataValue(item, 'upstream') as Record<string, unknown>, 'fetchedAt');
          return {
            response: { ok: true, live: true, retained: false,
              source: 'Statiq station detail (live)', station: stationDetail },
            fetchedAt: new Date(fetchedAt as string),
          };
        },
      );
      let stopCause: 'throttled' | 'auth' | undefined;
      for (let j = 0; j < items.length; j++) {
        const item = items[j] as BulkItemResult<StationDetailsWithMeta>;
        results.push(item);
        // Incremental detail progress: ingest as each batch resolves so a
        // later batch failure cannot erase earlier verified candidates.
        try { onItem?.(item, i + j); } catch { /* progress evidence only */ }
        if (item.outcome === 'unknown' &&
            (item.reason === 'upstream_auth' || item.reason === 'upstream_throttled')) {
          stopCause = item.reason === 'upstream_auth' ? 'auth' : 'throttled';
        }
      }
      if (stopCause) {
        this.runBudget?.stop(stopCause);
        throw new StatiqRunFatalError(stopCause, 0, BULK_DETAILS_PATH, 'per-item upstream fatal');
      }
    }
    return results;
  }

  /**
   * Attach the shared per-run attempt budget. Every transport attempt
   * (retries included) reserves against it, and the first 429/401/403
   * stops the whole run fail-closed. The client is per planning run
   * (single-run memo policy); attach BEFORE the first upstream call.
   */
  attachRunBudget(budget: UpstreamBudget, collector?: ProviderFailureCollector): void {
    this.runBudget = budget;
    if (collector) this.failureCollector = collector;
  }

  /** Attach a bounded, per-run completion-only evidence collector. */
  attachFailureCollector(collector: ProviderFailureCollector): void {
    this.failureCollector = collector;
  }

  private reportFailure(
    context: ProviderCallContext | undefined,
    path: string,
    code: Parameters<ProviderFailureCollector['record']>[0]['code'],
    dispatchSeq: number | null,
    httpStatus: number | null,
    gatewayFailureCode: ReturnType<typeof parseGatewayFailureCode> = null,
    gatewayUpstreamStatus: number | null = null,
    gatewayContractReason: ReturnType<typeof parseGatewayContractReason> = null,
    gatewayContractData: ReturnType<typeof parseGatewayContractData> = null,
  ): void {
    const collector = this.failureCollector;
    if (!collector) return;
    try {
      const endpointClass =
        path === '/stations/markers' || path === '/stations/markers-bulk' ? 'stations/markers' :
        path === '/stations/details' || path === '/stations/details-bulk' ? 'stations/details' : 'none';
      collector.record({
        endpointClass: context?.endpointClass ?? endpointClass,
        phase: context?.phase ?? (endpointClass === 'stations/markers' ? 'scan' : 'details'),
        // Details/route are null by contract; only marker context may carry ordinal.
        sampleOrdinal: endpointClass === 'stations/markers' ? context?.sampleOrdinal ?? null : null,
        dispatchSeq,
        httpStatus,
        code,
        gatewayFailureCode,
        gatewayUpstreamStatus,
        gatewayContractReason,
        gatewayContractData,
      });
    } catch {
      /* Diagnostics must never alter run behavior. */
    }
  }

  /**
   * Rolling-window rate limiter. Guaranteed properties (unit-tested with
   * a mocked transport and clock):
   * - no two upstream calls closer than `minCallGapMs`
   * - never more than `maxCallsPerMinute` calls in ANY rolling 60s window
   *   (stamps are retained 62s so boundary windows stay conservative)
   * - aborts promptly when `signal` fires while waiting (poll sleeps are
   *   capped at 200ms)
   * Waiters are SERIALIZED through `slotQueue`: only one waiter evaluates
   * the gap/window state at a time, so concurrent bursts cannot interleave
   * between the check and the stamp.
   */
  private acquireSlot(signal?: AbortSignal): Promise<void> {
    const turn = this.slotQueue.then(() => this.acquireSlotLocked(signal));
    // keep the queue moving even if this waiter aborts/fails
    this.slotQueue = turn.catch(() => {});
    return turn;
  }

  private async acquireSlotLocked(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new StatiqAbortError();
      const now = this.now();
      // Retain stamps past the window: a push is only allowed when even the
      // most conservative 60s window (ending now) holds < max calls. The
      // 62s retention is shared with the work-estimate module
      // (WINDOW_RETENTION_MS) so the limiter's effective sustained pacing
      // and the estimator can never drift apart.
      this.callStamps = this.callStamps.filter((t) => now - t < WINDOW_RETENTION_MS);
      const gapWait = this.lastCallAt + this.minCallGapMs - now;
      const windowFull = this.callStamps.length >= this.maxCallsPerMinute;
      if (!windowFull && gapWait <= 0) {
        const stamp = Math.max(now, this.lastCallAt + this.minCallGapMs);
        this.callStamps.push(stamp);
        this.lastCallAt = stamp;
        return;
      }
      const oldest = this.callStamps[0] ?? now;
      const windowWait = windowFull ? WINDOW_RETENTION_MS - (now - oldest) + 50 : 0;
      // wait at most ~200ms so an abort is noticed within one poll cycle
      await this.doSleep(Math.min(Math.max(gapWait, windowWait, 50), 200));
    }
  }

  /**
   * Abort-aware sleep: polls in <=200ms chunks so a deadline abort is
   * noticed within one poll cycle - even mid Retry-After wait.
   */
  private async sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    let remaining = Math.max(0, ms);
    for (;;) {
      if (signal?.aborted) throw new StatiqAbortError();
      if (remaining <= 0) return;
      const chunk = Math.min(remaining, 200);
      await this.doSleep(chunk);
      remaining -= chunk;
    }
  }

  /**
   * Backoff between attempts. A 429's Retry-After is honored IN FULL -
   * never truncated - plus a small jitter on top (so never earlier than
   * the server demanded). Otherwise: exponential with full jitter, capped
   * at 4s. All sleeps are abort-aware.
   */
  private async backoffMs(attempt: number, retryAfterMs: number | undefined, signal?: AbortSignal): Promise<void> {
    if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      await this.sleepAbortable(retryAfterMs + Math.random() * 250, signal);
      return;
    }
    const base = 250 * 2 ** Math.min(attempt, 4); // caps the exponential at 4s
    const jittered = Math.random() * base; // full jitter: 0..base
    await this.sleepAbortable(Math.min(jittered, 4_000) + 100, signal);
  }

/** Sanitized audit hook: one sanitized entry per upstream attempt. */
  private audit(endpoint: string, status: number): void {
    this.upstreamAttempts += 1;
    if (this.onUpstreamCall) {
      this.onUpstreamCall({
        seq: this.upstreamAttempts,
        endpoint: endpoint.replace(/^\/+/, ''),
        status,
        at: new Date().toISOString(),
      });
    }
  }

  /** Verified upstream attempts audited through this client (per run).
   *  Legacy: one audit per dispatched attempt. Bulk: one audit per VERIFIED
   *  per-item upstream attempt, emitted only after the whole envelope passed;
   *  this is also the audit seq source, never the pessimistic reservation. */
  upstreamCallsMade(): number {
    return this.upstreamAttempts;
  }

  /** Dispatched attempts after successful reservation, not completions.
   *  Legacy counts reservations (== dispatches); bulk counts the VERIFIED
   *  actual per-item attempts after the envelope reconciles. */
  dispatchedAttemptsMade(): number {
    return this.dispatchAttempts;
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    context?: ProviderCallContext,
    options: PostJsonOptions = {},
  ): Promise<T> {
    if (this.bulkFailureLatch) throw this.bulkFailureLatch;
    let lastError: unknown;
    let lastRetryAfterMs: number | undefined;
    let attemptEvidenceRecorded = false;
    // 1 initial attempt + `retries` retries; aborts are never retried
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        const override = lastRetryAfterMs;
        lastRetryAfterMs = undefined;
        // Never truncate the server-demanded wait: if honoring the full
        // Retry-After cannot fit inside this run's remaining deadline, fail
        // fast with the throttled error instead of retrying early.
        if (
          override != null &&
          this.runDeadlineAt != null &&
          this.now() + override > this.runDeadlineAt
        ) {
          if (lastError instanceof StatiqApiError) throw lastError;
          throw new StatiqApiError(429, path, 'throttled; Retry-After exceeds run deadline', override);
        }
        await this.backoffMs(attempt, override, signal);
      }
      // 1) Paced permit FIRST: the limiter (and any backoff above) is fully
      // awaited BEFORE any reservation - no up-front reservation can be
      // cancelled by another waiter finding the cap exhausted.
      try {
        await this.acquireSlot(signal);
      } catch (err) {
        this.reportFailure(context, path, signal?.aborted ? 'deadline' : transportCodeForCause(err), null, null);
        throw err;
      }
      // A permit can settle before this continuation runs. Refuse an
      // intervening abort BEFORE reservation, keeping reserved == dispatched.
      if (signal?.aborted) {
        this.reportFailure(context, path, 'deadline', null, null);
        throw new StatiqAbortError();
      }
      // A bulk batch owns the wire while active; no concurrent legacy
      // dispatch may start (no reservation has been made yet here).
      if (this.bulkInFlight) throw new StatiqAbortError('legacy dispatch refused while a bulk batch is active');
      if (this.bulkFailureLatch) throw this.bulkFailureLatch;
      // 2) Atomic reserve immediately before fetch, with NO await between a
      // successful reserve and the dispatch (reservation-race invariant):
      //  - fatal stop (first 429/401/403): this caller fails fast, zero NEW
      //    dispatch after the stop site-wide;
      //  - cap exhausted: ONLY this caller is refused (its earlier-paced
      //    permit is wasted, no traffic) - work already reserved by other
      //    callers proceeds; exhaustion never poisons shared state;
      //  - success: reserved == dispatched, so the shared counters always
      //    match real network work.
      try {
        this.runBudget?.reserveAttempt();
      } catch (err) {
        const code =
          err instanceof UpstreamRunStoppedError && err.cause === 'budget-exhausted'
            ? 'budget_exhausted'
            : err instanceof UpstreamRunStoppedError && err.cause === 'throttled'
              ? 'fatal_throttled'
              : 'fatal_auth';
        this.reportFailure(context, path, code, null, null);
        throw err;
      }
      // Dispatch seq is distinct from completion-order audit seq and exists
      // only after a successful reservation, immediately before fetch.
      const dispatchSeq = ++this.dispatchAttempts;
      try { context?.onDispatch?.(dispatchSeq); } catch { /* evidence callbacks never alter policy */ }
      attemptEvidenceRecorded = false;
      let gatewayFailureCode: ReturnType<typeof parseGatewayFailureCode> = null;
      let gatewayUpstreamStatus: number | null = null;
      let gatewayContractReason: ReturnType<typeof parseGatewayContractReason> = null;
      let gatewayContractData: ReturnType<typeof parseGatewayContractData> = null;
      const recordAttempt = (code: Parameters<ProviderFailureCollector['record']>[0]['code'], status: number | null): void => {
        if (attemptEvidenceRecorded) return;
        this.reportFailure(context, path, code, dispatchSeq, status,
          gatewayFailureCode, gatewayUpstreamStatus, gatewayContractReason, gatewayContractData);
        attemptEvidenceRecorded = true;
      };
      // ONE AUDIT PER ATTEMPT: header-time audit marks the attempt as
      // answered on the wire; the catch's audit-0 fallbacks skip when it
      // already ran (a body-read failure after headers must not double-).
      let attemptAudited = false;
      let fatalAtHeaders: StatiqRunFatalError | undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const onOuterAbort = () => controller.abort();
      signal?.addEventListener('abort', onOuterAbort, { once: true });
      try {
        const res = await this.fetchImpl(options.fetchUrl ?? this.base + path, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        // FATAL HEADERS STOP THE BUDGET IMMEDIATELY (contract repair; the
        // Linux offline repro raced 2/6): a fatal 401/403/429 is fully
        // known at HEADERS, but stopping only after the body resolved left
        // a window where another worker passed the budget gate and
        // DISPATCHED while the fatal body was still in flight.
        // Already-in-flight requests complete as legitimate work; ZERO NEW
        // DISPATCH may follow fatal headers. Diagnostics (audit entry with
        // the true status, the body on the error, the parsed Retry-After)
        // are retained after the stop.
        // Typing note: a LOCAL narrowed budget reference - TS cannot track
        // that fatalCause truthiness implies the budget exists through the
        // ternary, so the guard checks the reference directly. No non-null
        // suppression anywhere.
        // Gateway diagnostic headers are consumed ONLY from failed marker
        // responses. No values are logged, inferred from a status, or applied
        // to policy; header-read failures leave both fields null.
        if (path === '/stations/markers' && !res.ok) {
          try {
            gatewayFailureCode = parseGatewayFailureCode(res.headers?.get('x-evroute-failure-code'));
            if (gatewayFailureCode != null) {
              gatewayUpstreamStatus = parseGatewayUpstreamStatus(
                res.headers?.get('x-evroute-upstream-status'),
              );
            }
            if (gatewayFailureCode === 'upstream_contract') {
              try {
                gatewayContractReason = parseGatewayContractReason(
                  res.headers?.get('x-evroute-contract-reason'),
                );
              } catch { gatewayContractReason = null; }
              try {
                gatewayContractData = parseGatewayContractData(
                  res.headers?.get('x-evroute-contract-data'),
                );
              } catch { gatewayContractData = null; }
            }
          } catch { gatewayFailureCode = null; gatewayUpstreamStatus = null; }
        }
        const budget = this.runBudget;
        const fatalCause =
          !res.ok &&
          budget &&
          (res.status === 401 || res.status === 403 || res.status === 429)
            ? res.status === 429
              ? 'throttled'
              : 'auth'
            : undefined;
        const fatalRetryAfter =
          fatalCause === 'throttled'
            ? this.parseRetryAfterMs(res.headers?.get('retry-after'))
            : undefined;
        if (budget && fatalCause) {
          budget.stop(fatalCause, fatalRetryAfter);
          recordAttempt(fatalCause === 'throttled' ? 'fatal_throttled' : 'fatal_auth', res.status);
          // Preserve the known fatal status even if an aborted body cannot
          // supply diagnostics. No body is invented when none was read.
          fatalAtHeaders = new StatiqRunFatalError(fatalCause, res.status, path, '', fatalRetryAfter);
        }
        // HEADER-TIME AUDIT: the attempt reached the wire and answered with
        // this status - recorded even if the body then never arrives.
        this.audit(path, res.status);
        attemptAudited = true;
        // Observe real headers before cancellation: fatal status must still
        // stop the shared budget and every dispatched attempt audits once.
        if (signal?.aborted) {
          if (fatalAtHeaders) throw fatalAtHeaders;
          recordAttempt('deadline', res.status);
          throw new StatiqAbortError();
        }
        let text: string;
        try {
          text = await res.text();
        } catch (err) {
          if (fatalAtHeaders) throw fatalAtHeaders;
          recordAttempt('body_read_failure', res.status);
          throw err;
        }
        if (fatalCause) {
          // no retry path is entered under a budget: the fatal error carries
          // the full body diagnostics and the parsed wait for honest evidence
          throw new StatiqRunFatalError(fatalCause, res.status, path, text, fatalRetryAfter);
        }
        if (signal?.aborted) throw new StatiqAbortError();
        if (!res.ok) {
          const retryAfter =
            res.status === 429 ? this.parseRetryAfterMs(res.headers?.get('retry-after')) : undefined;
          // No budget (single-call revalidation): 4xx (except 429) are
          // permanent and not retried; 429/5xx retry honoring Retry-After.
          if (res.status >= 500 || res.status === 429) {
            recordAttempt(statusCodeForHttp(res.status), res.status);
            lastError = new StatiqApiError(res.status, path, text, retryAfter);
            lastRetryAfterMs = retryAfter;
            continue;
          }
          const initialError = new StatiqApiError(res.status, path, text, retryAfter);
          const candidate = options.rawEmptyConfirmation;
          if (!options.rawEmptyCheck && candidate && this.base === DEFAULT_STATIQ_BASE_URL &&
              res.status === 400 && gatewayFailureCode === 'upstream_contract' &&
              gatewayUpstreamStatus === 200 && gatewayContractReason === 'success_false' &&
              gatewayContractData === 'stations_empty') {
            recordAttempt(statusCodeForHttp(res.status), res.status);
            try {
              return await this.postJson<StatiqMarkersResponse>(
                '/station/v1/markers',
                { latitude: candidate.lat, longitude: candidate.lon, all_chargers: 0, connector_id: [], vertices: candidate.vertices },
                signal,
                context,
                { fetchUrl: TRUSTED_RAW_MARKERS_URL, rawEmptyCheck: true },
              ) as T;
            } catch (err) {
              if (err instanceof StatiqRunFatalError || err instanceof UpstreamRunStoppedError || signal?.aborted ||
                  (err instanceof StatiqApiError &&
                    (err.status === 401 || err.status === 403 || err.status === 429 || err.status >= 500))) throw err;
              throw initialError;
            }
          }
          throw initialError;
        }
        let parsed: T;
        try {
          parsed = JSON.parse(text) as T;
        } catch (err) {
          // Preserve the original retry policy; diagnostics only observe.
          // No raw body text is copied into diagnostics.
          recordAttempt('invalid_json', res.status);
          throw err;
        }
        if (!hasFreshProvenance(parsed)) {
          recordAttempt('nonfresh_provenance', res.status);
          throw new StatiqProvenanceError(path);
        }
        if (options.rawEmptyCheck) {
          if (!confirmedRawEmpty(res, parsed)) {
            recordAttempt('invalid_marker_list', res.status);
            throw new StatiqProvenanceError(path);
          }
          return {
            ok: true,
            live: true,
            retained: false,
            source: 'raw-confirmed-empty',
            count: 0,
            stations: [],
          } as T;
        }
        return parsed;
      } catch (err) {
        // run-fatal and budget-gate errors are never retried, never
        // counted as sample failures: they unwind the whole planning run
        if (err instanceof StatiqRunFatalError || err instanceof UpstreamRunStoppedError) {
          throw err;
        }
        if (fatalAtHeaders) throw fatalAtHeaders;
        // OUTER cancellation (run deadline / explicit abort) is never
        // retried. Detected by the AUTHORITATIVE signal state, NOT by the
        // error shape: an AbortError-shaped rejection without the outer
        // signal firing is the PER-REQUEST TIMEOUT (the 10s inner
        // controller), which is a retryable transport failure - see below.
        if (signal?.aborted) {
          if (!attemptAudited) this.audit(path, 0);
          recordAttempt('deadline', null);
          throw new StatiqAbortError();
        }
        // Every outbound attempt is auditable, even transport failures.
        // Per-request timeouts land here (inner-controller AbortError with
        // the outer signal alive): audited with status 0 and RETRIED like
        // any network failure - the attempt reached the wire and counts
        // against the run budget (actual attempts include retries). An
        // attempt that already answered at HEADERS is not re-audited (its
        // true status is already recorded; the body read failed after it).
        if (!(err instanceof StatiqApiError) && !attemptAudited) {
          this.audit(path, 0);
        }
        if (err instanceof StatiqProvenanceError) {
          throw err;
        }
        const wireStatus = err instanceof StatiqApiError ? err.status : null;
        const code =
          wireStatus != null && wireStatus > 0
            ? statusCodeForHttp(wireStatus)
            : controller.signal.aborted
              ? 'transport_timeout'
              : transportCodeForCause(err);
        recordAttempt(code, wireStatus != null && wireStatus > 0 ? wireStatus : null);
        if (err instanceof StatiqApiError && err.status < 500 && err.status !== 429) {
          throw err;
        }
        lastError = err;
        continue;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);
      }
    }
    if (lastError instanceof StatiqApiError) throw lastError;
    // No provider message is copied into the terminal error.
    throw new StatiqApiError(0, path, 'provider request failed');
  }

  /**
   * Parse Retry-After: the delay-seconds form ("120") OR the HTTP-date
   * form ("Wed, 21 Oct 2015 07:28:00 GMT", resolved against the client
   * clock so fake-clock tests stay deterministic). Unparseable -> undefined
   * (the caller falls back to default backoff timing).
   */
  private parseRetryAfterMs(header: string | null | undefined): number | undefined {
    if (!header) return undefined;
    const trimmed = header.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - this.now());
    return undefined;
  }
}
