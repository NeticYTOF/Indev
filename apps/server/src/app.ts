import { hasFreshProvenance, StatiqProvenanceError } from '@indeev/core';
/**
 * IndEV HTTP API.
 *
 * - One fresh StatiqClient per planning run (single-run memo policy).
 * - Every planning run is bounded: server run budget (deadline + upstream
 *   call cap), so a request can never hold the turn indefinitely.
 * - Saved trips are minimal (station refs + geometry); station data is
 *   always fetched live when viewed.
 * - Mock mode (INDEV_MOCK=1) serves synthetic plans/stations so UI work and
 *   repeatable UI tests never touch the live upstream.
 * - The bearer token lives only in the Statiq clients; it is never logged
 *   and never appears in any response.
 */
import { Hono, type Context, type Next } from 'hono';
import {
  CountersStore,
  StoreLockCleanupError,
  StoreLockBusyError,
  STORE_LOCK_CLEANUP_WARNING,
  type SavedTrip,
  recordPlanCounter,
  createProviderFailureCollector,
  emptyProviderFailureReport,
  type ProviderFailureReport,
  OsrmRouter,
  PhotonGeocoder,
  PlanningError,
  StatiqClient,
  TripsStore,
  VehicleSelectionError,
  planTrip,
  resolveVehicle,
  VEHICLE_CATALOG,
  summarizeCcs2,
  DEFAULT_HARRIER_ENTRY_ID,
  DEFAULT_PLAN_OPTIONS,
  type PlanOptions,
  type PlanRunBudget,
  type ResolvedVehicle,
  type PlaceRef,
  type TripPlan,
  type VehicleSelection,
  type RunCoverageSnapshot,
} from '@indeev/core';
import { PlanJobRegistry, type PlanJobControls } from './plan-job.js';
import { runSelective, SelectiveRunError, type FinalAnswerDiagnostic } from './selective-run.js';
import { SingleRunSlot } from './run-slot.js';
import type { AiToolCall } from './ai-provider.js';
import { DEFAULT_ALLOWED_WEB_ORIGINS } from './env.js';
import { validSavedPlanMetadata } from './saved-plan-validation.js';


export interface AppDeps {
  /** Creates a fresh Statiq client for one planning run. The optional
   *  opts carry an EXPLICIT per-launch retry override (env-configured)
   *  and, for long jobs, the run's own deadline. Sync callers omit the
   *  deadline so the launch default remains unchanged. */
  createStatiq: (opts?: { retries?: number; deadlineMs?: number }) => StatiqClient;
  router: OsrmRouter;
  geocoder: PhotonGeocoder;
  trips: TripsStore;
  counters: CountersStore;
  mock: boolean;
  /** Sanitized run summary plus bounded, completion-only failure evidence. */
  onRunComplete?: (
    outcome: string,
    upstreamCalls: number,
    providerFailures?: ProviderFailureReport,
  ) => void;
  /** Private host-only diagnostic sink. Carries bounded reason codes and
   *  counts, never model output, prompts, headers or public API fields. */
  onPlanRunEvent?: (event: {
    outcome: string;
    hostReasons: Array<{ stationId: number; reasons: string[] }>;
    detailChecksStarted: number;
    detailChecksSettled: number;
    finalAnswerEvents?: FinalAnswerDiagnostic[];
  }) => void;
  /** AI planning config: all three set = enabled. Off by default. */
  ai?: { baseUrl: string; apiKey: string; model: string };
  /** Injectable for tests; defaults to the real provider call. */
  aiCall?: (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, signal?: AbortSignal) => Promise<string>;
  /** Injectable tool-call transport for isolated tests; production uses the
   *  real OpenAI-compatible provider inside the selective engine. */
  aiToolCall?: AiToolCall;
  /**
   * EXPLICIT bounded planning-budget override (operator-supplied, e.g. for
   * a coordinated acceptance). Absent = SERVER_RUN_BUDGET defaults,
   * byte-identical to before; present = validated by loadEnv at boot.
   * Never raised automatically - only an explicit launch choice.
   */
  planRunBudget?: PlanRunBudget;
  /** Explicit per-launch client retry override (0..3, validated); the
   *  StatiqClient default (2) applies when absent. */
  statiqRetries?: number;
  /**
   * Per-launch instance identity (a launcher-generated UUID): echoed in
   * /api/health as `launchId` so a launcher can gate on ITS OWN server
   * instance. NOT a credential; absent = null in health (plain dev
   * launches need no identity). This is the provenance gate that killed
   * the unrelated-same-mode-server acceptance race.
   */
  launchId?: string;
  /** Exact browser origins allowed to mutate/consume providers locally. */
  allowedWebOrigins?: readonly string[];
}

/** Server-side bounds for a planning request. */
export const SERVER_RUN_BUDGET = { deadlineMs: 4 * 60_000, maxUpstreamCalls: 200 };

const PLANNING_CODE_TO_STATUS: Record<string, number> = {
  not_determined: 422,
  no_route: 422,
  infeasible: 422,
};

/**
 * Fine-grained audit outcome for a planning error: code plus cause when we
 * have one (e.g. not_determined:throttled, not_determined:budget-exhausted)
 * so throttled runs stay distinguishable from coverage holes afterwards.
 */
function auditOutcomeFor(err: unknown): string {
  if (err instanceof PlanningError) {
    return err.cause ? `${err.code}:${err.cause}` : err.code;
  }
  return 'error';
}

/**
 * Admit only OWN, finite, nonnegative numeric fields plus the explicit
 * boolean. A malformed snapshot is rejected outright: it must never be
 * presented as truth. No inherited keys, strings, NaN or negatives.
 */
function validatedCoverage(value: unknown): RunCoverageSnapshot | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const own = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
  const num = (key: string): number | undefined => {
    const v = own(key);
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  };
  const samplesPlanned = num('samplesPlanned');
  const samplesCompleted = num('samplesCompleted');
  const samplesOk = num('samplesOk');
  const samplesFailed = num('samplesFailed');
  const candidatesPlanned = num('candidatesPlanned');
  const candidatesProcessed = num('candidatesProcessed');
  const candidatesDetailed = num('candidatesDetailed');
  const observedAttempts = num('observedAttempts');
  const maxAttempts = num('maxAttempts');
  const unconfirmedReservations = num('unconfirmedReservations');
  const remainingCalls = num('remainingCalls');
  const remainingEstimateMs = num('remainingEstimateMs');
  const pacePerCallMs = num('pacePerCallMs');
  const candidateInventoryComplete = own('candidateInventoryComplete');
  if (typeof candidateInventoryComplete !== 'boolean' ||
      samplesPlanned === undefined || samplesCompleted === undefined ||
      samplesOk === undefined || samplesFailed === undefined ||
      candidatesPlanned === undefined || candidatesProcessed === undefined ||
      candidatesDetailed === undefined || observedAttempts === undefined ||
      maxAttempts === undefined || unconfirmedReservations === undefined ||
      remainingCalls === undefined || remainingEstimateMs === undefined ||
      pacePerCallMs === undefined) return undefined;
  return {
    samplesPlanned, samplesCompleted, samplesOk, samplesFailed,
    candidatesPlanned, candidatesProcessed, candidatesDetailed,
    candidateInventoryComplete,
    observedAttempts, maxAttempts, unconfirmedReservations,
    remainingCalls, remainingEstimateMs, pacePerCallMs,
  };
}

function safeUpstreamCalls(statiq: StatiqClient): number {
  // Optional observability must never turn a valid request into a 500.
  try {
    const observer = (statiq as unknown as { upstreamCallsMade?: unknown }).upstreamCallsMade;
    if (typeof observer !== 'function') return 0;
    const value = (observer as () => unknown).call(statiq);
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function completeRun(
  deps: AppDeps,
  outcome: string,
  upstreamCalls: number,
  evidence: ProviderFailureReport = emptyProviderFailureReport(),
): void {
  // The observer is diagnostic only; its failure cannot change a response.
  try { deps.onRunComplete?.(outcome, upstreamCalls, evidence); } catch { /* ignored */ }
}

function emitPlanRunEvent(
  deps: AppDeps,
  outcome: string,
  diagnostics: { hostReasons: Array<{ stationId: number; reasons: string[] }>;
    detailChecksStarted: number; detailChecksSettled: number;
    finalAnswerEvents?: FinalAnswerDiagnostic[] },
): void {
  try {
    deps.onPlanRunEvent?.({
      outcome,
      hostReasons: diagnostics.hostReasons.slice(0, 25),
      detailChecksStarted: diagnostics.detailChecksStarted,
      detailChecksSettled: diagnostics.detailChecksSettled,
      ...(diagnostics.finalAnswerEvents && diagnostics.finalAnswerEvents.length > 0
        ? { finalAnswerEvents: diagnostics.finalAnswerEvents.slice(0, 5) } : {}),
    });
  } catch { /* diagnostics never alter the run */ }
}

/** Validated, caller-owned inputs for one live AI-plan run. */
interface LivePlanParams {
  origin: PlaceRef;
  destination: PlaceRef;
  via: readonly PlaceRef[];
  maxChargerKw: number | undefined;
  startSocPct: number | undefined;
  resolved: ResolvedVehicle;
  customRequest: string | undefined;
}

interface AiPlanEnvelope {
  plan: TripPlan;
  ai: { applied: boolean; notes?: string; reason?: string };
}

/**
 * The single live path shared by the sync endpoint and long-running jobs.
 * Only the caller-owned budget, signal and progress sink differ; one fresh
 * paced client is created per run and every attempt is audited.
 */
async function runLiveAiPlan(
  deps: AppDeps,
  statiqRetries: number | undefined,
  params: LivePlanParams,
  controls: PlanJobControls,
): Promise<AiPlanEnvelope> {
  const statiq = deps.createStatiq({ retries: statiqRetries, deadlineMs: controls.budget.deadlineMs });
  const planOptions: PlanOptions = {
    runBudget: controls.budget,
    via: params.via,
    ...(params.maxChargerKw === undefined ? {} : { maxChargerKw: params.maxChargerKw }),
    ...(params.startSocPct === undefined ? {} : { startSocPct: params.startSocPct }),
  };
  const safeRange = params.resolved.realWorldRangeKm;
  if (safeRange != null && Number.isFinite(safeRange)) {
    planOptions.maxLegKm = Math.min(planOptions.maxLegKm ?? DEFAULT_PLAN_OPTIONS.maxLegKm, safeRange);
  }
  const progress = {
    samplesPlanned: 0, samplesCompleted: 0, samplesOk: 0, samplesFailed: 0,
    candidatesPlanned: 0, candidatesProcessed: 0, candidatesDetailed: 0,
    candidateInventoryComplete: false, scanMs: 0, detailsStartedAt: null,
  };
  try {
    const run = await runSelective({
      ai: deps.ai!, router: deps.router, statiq,
      aiToolCall: deps.aiToolCall,
      origin: params.origin, destination: params.destination, via: params.via,
      resolved: params.resolved, planOptions,
      customRequest: params.customRequest, budget: controls.budget,
      signal: controls.signal,
      onStage: (stage, processed, planned, counts) => {
        if (stage === 'discovery') {
          progress.samplesCompleted = processed;
          progress.samplesPlanned = planned;
          if (counts) {
            progress.samplesOk = counts.ok;
            progress.samplesFailed = counts.failed;
          }
        } else if (stage === 'shortlist') {
          progress.candidatesPlanned = planned;
          progress.candidateInventoryComplete = true;
          if (counts) {
            progress.samplesOk = counts.ok;
            progress.samplesFailed = counts.failed;
          }
        } else if (stage === 'details') {
          progress.candidatesProcessed = processed;
        }
        controls.onProgress?.({ ...progress });
      },
    });
    progress.samplesOk = run.diagnostics.samplesOk;
    progress.samplesFailed = run.diagnostics.samplesFailed;
    progress.candidatesDetailed = run.diagnostics.candidatesDetailed;
    if (controls.signal?.aborted) throw new Error('aborted');
    // Counts are recorded only after a fully validated final plan.
    await recordPlanCounter(deps.counters, run.plan);
    completeRun(deps, 'ok',
      Math.max(run.diagnostics.observedAttempts, safeUpstreamCalls(statiq)),
      run.diagnostics.failures);
    emitPlanRunEvent(deps, 'ok', run.diagnostics);
    return { plan: run.plan, ai: { applied: true, ...(run.notes ? { notes: run.notes } : {}) } };
  } catch (err) {
    if (controls.signal?.aborted) throw new Error('aborted');
    const failure = err instanceof PlanningError
      ? err
      : new PlanningError(
          err instanceof Error ? err.message : 'The selective run did not determine a certified plan.',
          'not_determined',
        );
    const diag = err instanceof SelectiveRunError ? err.diagnostics : null;
    if (diag) {
      progress.samplesOk = diag.samplesOk;
      progress.samplesFailed = diag.samplesFailed;
      progress.candidatesDetailed = diag.candidatesDetailed;
    }
    failure.coverage ??= {
      ...progress,
      observedAttempts: diag?.observedAttempts ?? safeUpstreamCalls(statiq),
      maxAttempts: diag?.maxAttempts ?? controls.budget.maxUpstreamCalls,
      unconfirmedReservations: diag?.unconfirmedReservations ?? 0,
      // Remaining budget capacity, NOT a claim about calls still required.
      remainingCalls: diag?.remainingBudget ?? 0,
      remainingEstimateMs: 0,
      pacePerCallMs: 0,
    };
    completeRun(deps, auditOutcomeFor(failure),
      diag?.observedAttempts ?? safeUpstreamCalls(statiq),
      diag?.failures ?? emptyProviderFailureReport());
    if (diag) emitPlanRunEvent(deps, auditOutcomeFor(failure), diag);
    throw failure;
  }
}

/** Long jobs get a finite continuous budget that can cover a full corridor;
 *  the 4-minute sync default is deliberately not reused or reset per poll. */
const JOB_RUN_BUDGET: PlanRunBudget = { deadlineMs: 30 * 60_000, maxUpstreamCalls: 600 };
const JOB_MAX_ACTIVE = 1;
const JOB_MAX_RETAINED = 20;
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const allowedWebOrigins = new Set(deps.allowedWebOrigins ?? DEFAULT_ALLOWED_WEB_ORIGINS);

  const browserGate = (requireJson: boolean) => async (c: Context, next: Next) => {
    // Fetch Metadata can identify a browser subresource even when no-cors
    // omits Origin. Check it independently of Origin; nonbrowser clients
    // that send neither header remain supported.
    const fetchSite = c.req.header('sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin') {
      return c.json({ error: 'browser origin is not allowed', code: 'origin_denied' }, 403);
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && !allowedWebOrigins.has(origin)) {
      return c.json({ error: 'browser origin is not allowed', code: 'origin_denied' }, 403);
    }
    if (requireJson && c.req.method === 'POST') {
      const contentType = c.req.header('content-type');
      const mediaType = contentType?.split(';')[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return c.json({ error: 'Content-Type must be application/json', code: 'bad_request' }, 400);
      }
    }
    await next();
  };
  for (const path of ['/api/plan', '/api/ai/plan', '/api/trips', '/api/jobs/plan']) {
    app.use(path, browserGate(true));
  }
  for (const path of ['/api/trips/:id', '/api/geocode', '/api/stations/:id', '/api/jobs/plan/:id']) {
    app.use(path, browserGate(false));
  }
  // The EFFECTIVE planning budget: the explicit bounded override when the
  // operator supplied one (validated at boot), else the server default.
  const runBudget = deps.planRunBudget ?? SERVER_RUN_BUDGET;
  const statiqRetries = deps.statiqRetries;

  const runSlot = new SingleRunSlot();
  const jobs = new PlanJobRegistry<LivePlanParams>(
    (controls, params) => runLiveAiPlan(deps, statiqRetries, params, controls),
    {
      maxActive: JOB_MAX_ACTIVE,
      budget: JOB_RUN_BUDGET,
      maxRetained: JOB_MAX_RETAINED,
      acquire: () => runSlot.acquire(),
    },
  );

  app.onError((err, c) => {
    if (err instanceof StatiqProvenanceError) return c.json({ error: err.message, code: 'upstream_invalid' }, 502);
    if (err instanceof StoreLockBusyError) {
      return c.json({ error: err.message, code: 'storage_busy' }, 423);
    }
    if (err instanceof PlanningError) {
      const status = PLANNING_CODE_TO_STATUS[err.code] ?? 422;
      // The fine-grained cause travels in the HTTP body too, not just the
      // audit outcome: the UI needs it to give cause-true guidance (a
      // budget-exhausted run is NOT "the API is throttling - retry now").
      // Absent for cause-less errors (no_route, infeasible).
      const coverage = validatedCoverage(err.coverage);
      return c.json(
        {
          error: err.message,
          code: err.code,
          ...(err.cause ? { cause: err.cause } : {}),
          ...(coverage ? { coverage } : {}),
        },
        status as never,
      );
    }
    if (err instanceof VehicleSelectionError) {
      return c.json({ error: err.message, code: 'bad_vehicle' }, 400);
    }
    console.error('Unhandled server error:', err instanceof Error ? err.message : err);
    return c.json({ error: 'Internal error', code: 'internal' }, 500);
  });

  app.get('/api/health', async (c) => {
    const counters = await deps.counters.load().catch(() => null);
    return c.json({
      ok: true,
      mock: deps.mock,
      chargersSeen: counters?.chargersSeen ?? null,
      counterAvailable: counters !== null,
      ai: Boolean(deps.ai),
      // INSTANCE PROVENANCE: the launcher-generated launch id echoed back so
      // a launcher can prove this health answer came from its OWN child (a
      // random UUID per launch - sanitized, never a credential)
      launchId: deps.launchId ?? null,
      // Sanitized introspection (no secrets): the effective planning
      // envelope this server was launched with
      runBudget: {
        maxUpstreamCalls: runBudget.maxUpstreamCalls,
        deadlineMs: runBudget.deadlineMs,
        retries: statiqRetries ?? 2, // 2 = the StatiqClient default
      },
    });
  });

  app.get('/api/vehicles', (c) => {
    // Claims are explicitly labelled; real-world range is user input only.
    return c.json({
      default: DEFAULT_HARRIER_ENTRY_ID,
      catalog: VEHICLE_CATALOG,
      note: 'claimedRangeKm values are manufacturer claims (MIDC/ARAI), not real-world range.',
    });
  });

  app.get('/api/geocode', async (c) => {
    const q = c.req.query('q');
    if (!q || q.trim().length < 2) {
      return c.json({ hits: [] });
    }
    if (deps.mock) {
      return c.json({ hits: mockGeocode(q) });
    }
    const all = await deps.geocoder.search(q.trim(), 8);
    // India-first: if any India hit exists, drop foreign ones (this is an
    // India route planner); then dedupe by place identity.
    const indian = all.filter((h) => h.country === 'India');
    const pool = indian.length > 0 ? indian : all;
    const seen = new Set<string>();
    const hits = pool.filter((h) => {
      const key = `${h.name}::${h.lat.toFixed(3)},${h.lon.toFixed(3)}::${h.state ?? ''}::${h.city ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return c.json({ hits: hits.slice(0, 6) });
  });

  app.post('/api/plan', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid JSON body', code: 'bad_request' }, 400);
    }
    const b = body as {
      origin?: { label?: string; lat?: number; lon?: number };
      destination?: { label?: string; lat?: number; lon?: number };
      via?: unknown;
      vehicle?: VehicleSelection;
      startSocPct?: number;
      maxChargerKw?: unknown;
    };
    const providerFailures = createProviderFailureCollector();
    const origin = coordRef(b.origin);
    const destination = coordRef(b.destination);
    if (!origin || !destination) {
      return c.json(
        { error: 'origin and destination each need label, lat and lon', code: 'bad_request' },
        400,
      );
    }

    const via = readVia(b.via);
    if (!via.ok) {
      return c.json({ error: 'via must be an array of at most 5 places with label, lat and lon', code: 'bad_request' }, 400);
    }
    const maxCharger = readMaxChargerKw(b.maxChargerKw);
    if (!maxCharger.ok) {
      return c.json({ error: 'maxChargerKw must be a finite positive number', code: 'bad_request' }, 400);
    }
    if (deps.mock && via.value.length > 0) {
      return c.json({ error: 'Synthetic demo planning supports only A-B trips; ordered stopovers require live routing.', code: 'unsupported_mock_stopovers' }, 422);
    }

    const startSoc = readStartSocPct(b.startSocPct);
    if (!startSoc.ok) {
      return c.json({ error: 'startSocPct must be a finite number', code: 'bad_request' }, 400);
    }

    // Vehicle selection (real-world range separation, never invented) -
    // resolved BEFORE the mock branch so synthetic plans echo the request
    // vehicle truthfully and validation errors behave identically in both
    // modes.
    let resolved: ResolvedVehicle;
    try {
      resolved = resolveVehicle(b.vehicle);
    } catch (err) {
      if (err instanceof VehicleSelectionError) throw err;
      throw err;
    }

    if (deps.mock) {
      const plan = mockPlan(origin, destination, resolved);
      await recordPlanCounter(deps.counters, plan);
      // synthetic plans make zero upstream calls; the run audit stays honest
      completeRun(deps, 'ok', 0);
      return c.json({ plan });
    }

    const release = runSlot.acquire();
    if (!release) {
      return c.json({ error: 'Another planning run is active on this server.', code: 'run_busy' }, 503 as never);
    }
    try {
    const statiq = deps.createStatiq({ retries: statiqRetries });
    const options: PlanOptions = {
      startSocPct: startSoc.value,
      via: via.value,
      runBudget,
      ...(maxCharger.value === undefined ? {} : { maxChargerKw: maxCharger.value }),
    };
    try {
      const plan = await planTrip(
        { router: deps.router, statiq, vehicle: resolved.config, resolvedVehicle: resolved,
          failureCollector: providerFailures },
        origin,
        destination,
        options,
      );
      // Persist only the running count of chargers seen; never station data.
      await recordPlanCounter(deps.counters, plan);
      completeRun(deps, 'ok', safeUpstreamCalls(statiq), providerFailures.snapshot());
      return c.json({ plan });
    } catch (err) {
      completeRun(deps, auditOutcomeFor(err), safeUpstreamCalls(statiq), providerFailures.snapshot());
      throw err;
    }
    } finally { release(); }
  });

  app.post('/api/ai/plan', async (c) => {
    const body = await c.req.json().catch(() => null);
    const b = body as {
      origin?: { label?: string; lat?: number; lon?: number };
      destination?: { label?: string; lat?: number; lon?: number };
      via?: unknown;
      vehicle?: VehicleSelection;
      startSocPct?: number;
      maxChargerKw?: unknown;
      request?: string;
    } | null;
    const origin = coordRef(b?.origin);
    const destination = coordRef(b?.destination);
    if (!origin || !destination) {
      return c.json(
        { error: 'origin and destination each need label, lat and lon', code: 'bad_request' },
        400,
      );
    }

    const via = readVia(b?.via);
    if (!via.ok) {
      return c.json({ error: 'via must be an array of at most 5 places with label, lat and lon', code: 'bad_request' }, 400);
    }
    const maxCharger = readMaxChargerKw(b?.maxChargerKw);
    if (!maxCharger.ok) {
      return c.json({ error: 'maxChargerKw must be a finite positive number', code: 'bad_request' }, 400);
    }
    if (deps.mock && via.value.length > 0) {
      return c.json({ error: 'Synthetic demo planning supports only A-B trips; ordered stopovers require live routing.', code: 'unsupported_mock_stopovers' }, 422);
    }

    const startSoc = readStartSocPct(b?.startSocPct);
    if (!startSoc.ok) {
      return c.json({ error: 'startSocPct must be a finite number', code: 'bad_request' }, 400);
    }

    // Vehicle selection resolves first in ALL modes (mock echoes it).
    let resolved: ResolvedVehicle;
    try {
      resolved = resolveVehicle(b?.vehicle);
    } catch (err) {
      if (err instanceof VehicleSelectionError) throw err;
      throw err;
    }

    // MOCK MODE: even an explicitly configured AI must never reach upstream.
    // Serve the same synthetic plan /api/plan would, with an honest label.
    if (deps.mock) {
      const plan = mockPlan(origin, destination, resolved);
      await recordPlanCounter(deps.counters, plan);
      completeRun(deps, 'ok', 0);
      return c.json({
        plan,
        ai: {
          applied: false,
          reason: 'Synthetic plan (mock mode): AI planning is unavailable and never reaches live upstream.',
        },
      });
    }

    // AI planning is OFF unless AI_BASE_URL + AI_API_KEY + AI_MODEL are set.
    if (!deps.ai) {
      return c.json(
        { error: 'AI planning is disabled on this server (no AI provider configured).', code: 'ai_disabled' },
        503 as never,
      );
    }
    const customRequest =
      typeof b?.request === 'string' && b.request.trim() ? b.request.trim().slice(0, 2000) : undefined;

    const release = runSlot.acquire();
    if (!release) {
      return c.json({ error: 'Another planning run is active on this server.', code: 'run_busy' }, 503 as never);
    }
    try {
      // Same live path a long job uses; only the budget differs. The sync
      // endpoint has no external cancel signal or polling progress sink.
      const envelope = await runLiveAiPlan(
        deps,
        statiqRetries,
        {
          origin,
          destination,
          via: via.value,
          maxChargerKw: maxCharger.value,
          startSocPct: startSoc.value,
          resolved,
          customRequest,
        },
        { budget: runBudget },
      );
      return c.json(envelope);
    } finally { release(); }
  });

  // Process-local long jobs: the POST returns immediately; the run owns its
  // own budget and signal. Status/cancel never touch the provider.
  app.post('/api/jobs/plan', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid JSON body', code: 'bad_request' }, 400);
    }
    const b = body as {
      origin?: { label?: string; lat?: number; lon?: number };
      destination?: { label?: string; lat?: number; lon?: number };
      via?: unknown;
      vehicle?: VehicleSelection;
      startSocPct?: number;
      maxChargerKw?: unknown;
      request?: string;
    };
    const origin = coordRef(b.origin);
    const destination = coordRef(b.destination);
    if (!origin || !destination) {
      return c.json({ error: 'origin and destination each need label, lat and lon', code: 'bad_request' }, 400);
    }
    const via = readVia(b.via);
    if (!via.ok) {
      return c.json({ error: 'via must be an array of at most 5 places with label, lat and lon', code: 'bad_request' }, 400);
    }
    const maxCharger = readMaxChargerKw(b.maxChargerKw);
    if (!maxCharger.ok) {
      return c.json({ error: 'maxChargerKw must be a finite positive number', code: 'bad_request' }, 400);
    }
    const startSoc = readStartSocPct(b.startSocPct);
    if (!startSoc.ok) {
      return c.json({ error: 'startSocPct must be a finite number', code: 'bad_request' }, 400);
    }
    if (deps.mock) {
      return c.json({ error: 'Long-running jobs require live planning; mock mode is synchronous.', code: 'unsupported_mock_jobs' }, 422);
    }
    if (!deps.ai) {
      return c.json({ error: 'AI planning is disabled on this server (no AI provider configured).', code: 'ai_disabled' }, 503 as never);
    }
    let resolved: ResolvedVehicle;
    try { resolved = resolveVehicle(b.vehicle); } catch (err) { throw err; }
    const customRequest =
      typeof b.request === 'string' && b.request.trim() ? b.request.trim().slice(0, 2000) : undefined;
    const started = jobs.start({
      origin, destination, via: via.value,
      maxChargerKw: maxCharger.value, startSocPct: startSoc.value,
      resolved, customRequest,
    });
    if (!started.ok) {
      return c.json({ error: 'The server is at its active job limit.', code: 'job_capacity' }, 503 as never);
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ jobId: started.jobId, capability: started.capability, budget: JOB_RUN_BUDGET }, 202);
  });

  app.get('/api/jobs/plan/:id', (c) => {
    // Both the id and the one-time capability are required; ids alone never
    // disclose a job. Never log either value.
    const status = jobs.status(c.req.param('id'), c.req.header('x-job-capability'));
    c.header('Cache-Control', 'no-store');
    return status
      ? c.json(status)
      : c.json({ error: 'Job not found', code: 'job_not_found' }, 404);
  });

  app.delete('/api/jobs/plan/:id', (c) => {
    return jobs.cancel(c.req.param('id'), c.req.header('x-job-capability'))
      ? c.json({ cancelled: true })
      : c.json({ error: 'Job not active or not owned', code: 'job_not_active' }, 409);
  });

  app.get('/api/trips', async (c) => {
    const trips = await deps.trips.list();
    return c.json({ trips });
  });

  app.get('/api/trips/:id', async (c) => {
    const trip = await deps.trips.get(c.req.param('id'));
    if (!trip) return c.json({ error: 'Trip not found', code: 'not_found' }, 404);
    return c.json({ trip });
  });

  app.post('/api/trips', async (c) => {
    const body = await c.req.json().catch(() => null);
    const plan = (body as { plan?: TripPlan; name?: string } | null)?.plan;
    if (
      !plan ||
      typeof plan !== 'object' ||
      typeof plan.id !== 'string' ||
      !plan.origin ||
      !plan.destination ||
      !Array.isArray(plan.geometry) ||
      !Array.isArray(plan.stops) ||
      !plan.totals ||
      !plan.vehicle
    ) {
      return c.json({ error: 'A live plan object is required to save a trip', code: 'bad_request' }, 400);
    }
    const via = readVia(plan.via);
    if (!via.ok) {
      return c.json({ error: 'Saved trip stopovers are malformed', code: 'bad_request' }, 400);
    }

    // sanity-check stop station refs so corrupted plans cannot be persisted
    for (const s of plan.stops) {
      if (!s || !s.station || typeof s.station !== 'object' || !Number.isInteger(s.station.stationId) || s.station.stationId <= 0) {
        return c.json({ error: 'Plan stops are malformed', code: 'bad_request' }, 400);
      }
    }
    // PROVENANCE: the live store only accepts live plans; the mock store
    // only accepts synthetic ones. Neither store ever mixes provenance.
    const expectedSource = deps.mock ? 'synthetic' : 'live';
    if (plan.source !== expectedSource) {
      return c.json(
        {
          error: deps.mock
            ? 'Only synthetic (mock) plans can be saved to the mock store'
            : 'Only live plans can be saved to the real trip store',
          code: 'wrong_provenance',
        },
        400,
      );
    }
    if (!validSavedPlanMetadata(plan)) {
      return c.json({ error: 'Saved plan metadata is malformed', code: 'bad_request' }, 400);
    }
    // Saved routes must be redrawable. Reject the whole malformed path;
    // never discard points or fabricate replacement geometry.
    if (plan.geometry.length < 2 || plan.geometry.some((point) => !coordRef(point))) {
      return c.json({ error: 'Plan geometry is malformed', code: 'bad_request' }, 400);
    }
    // Minimal saved references feed map pins and text renderers directly.
    // Validate rather than saving coordinates/labels those views cannot use.
    const name = (body as { name?: unknown }).name;
    if (
      !coordRef(plan.origin) || typeof plan.origin.label !== 'string' ||
      !coordRef(plan.destination) || typeof plan.destination.label !== 'string' ||
      plan.stops.some((stop) => !coordRef(stop.station) || typeof stop.station.name !== 'string') ||
      (name != null && typeof name !== 'string')
    ) {
      return c.json({ error: 'Saved trip coordinates or names are malformed', code: 'bad_request' }, 400);
    }
    try {
      const saved = await deps.trips.save(via.value.length > 0 ? { ...plan, via: via.value } : plan, name as string | undefined);
      return c.json({ trip: saved }, 201);
    } catch (error) {
      if (error instanceof StoreLockCleanupError && error.committed) {
        return c.json({ trip: error.result as SavedTrip, warnings: [STORE_LOCK_CLEANUP_WARNING], storage: { committed: true, lockReleased: false } }, 201);
      }
      throw error;
    }
  });

  app.delete('/api/trips/:id', async (c) => {
    let removed: boolean;
    let cleanupFailed = false;
    try {
      removed = await deps.trips.remove(c.req.param('id'));
    } catch (error) {
      if (!(error instanceof StoreLockCleanupError) || typeof error.result !== 'boolean') throw error;
      removed = error.result;
      cleanupFailed = true;
    }
    const extra = cleanupFailed ? { warnings: [STORE_LOCK_CLEANUP_WARNING], storage: { committed: removed, lockReleased: false } } : {};
    if (!removed) return c.json({ error: 'Trip not found', code: 'not_found', ...extra }, 404);
    return c.json({ ok: true, ...extra });
  });

  app.get('/api/stations/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'station id must be a positive integer', code: 'bad_request' }, 400);
    }
    if (deps.mock) {
      return c.json({ station: mockStation(id) });
    }
    // Always a FRESH client: station views must never come from a memo.
    // Per-launch retry override applies here too (client behavior); the
    // plan budget override does not (single-call revalidation has no run).
    const statiq = deps.createStatiq({ retries: statiqRetries });
    const { response, fetchedAt } = await statiq.detailsWithMeta(id);
    // Never revalidate one station with another station's plug data.
    // An invalid upstream reply is unavailable evidence, not a successful
    // refresh or proof that the requested station does not exist.
    if (!hasFreshProvenance(response) || !response || response.ok !== true ||
        (response.station && (response.station.stationId !== id ||
          !Array.isArray(response.station.chargers) ||
          response.station.chargers.some((charger) => !charger || !Array.isArray(charger.connectors))))) {
      return c.json({ error: 'Station details could not be verified. Please retry.', code: 'upstream_invalid' }, 502);
    }
    if (!response.station) {
      return c.json({ error: 'Station not found', code: 'not_found' }, 404);
    }
    return c.json({
      station: {
        ...liveStationView(response.station),
        fetchedAt: fetchedAt.toISOString(),
      },
    });
  });

  return app;
}

function coordRef(v: unknown): { label: string; lat: number; lon: number } | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { label?: unknown; lat?: unknown; lon?: unknown };
  if (
    typeof o.lat === 'number' &&
    Number.isFinite(o.lat) &&
    o.lat >= -90 && o.lat <= 90 &&
    typeof o.lon === 'number' &&
    Number.isFinite(o.lon) &&
    o.lon >= -180 && o.lon <= 180
  ) {
    return {
      label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : `${o.lat.toFixed(4)}, ${o.lon.toFixed(4)}`,
      lat: o.lat,
      lon: o.lon,
    };
  }
  return null;
}

function readVia(value: unknown): { ok: true; value: PlaceRef[] } | { ok: false } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > 5 || Object.keys(value).length !== value.length) return { ok: false };
  const places: PlaceRef[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return { ok: false };
    const place = raw as { label?: unknown };
    if (typeof place.label !== 'string' || !place.label.trim()) return { ok: false };
    const coord = coordRef(place);
    if (!coord) return { ok: false };
    places.push({ label: place.label.trim(), lat: coord.lat, lon: coord.lon });
  }
  return { ok: true, value: places };
}

type MaxChargerRead = { ok: true; value: number | undefined } | { ok: false };

function readMaxChargerKw(v: unknown): MaxChargerRead {
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return { ok: false };
  return { ok: true, value: v };
}

type StartSocRead = { ok: true; value: number | undefined } | { ok: false };

function readStartSocPct(v: unknown): StartSocRead {
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false };
  return { ok: true, value: clampSoc(v) };
}

function clampSoc(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(100, Math.max(5, v));
}

/**
 * Minimal live station payload for revalidation views (rating, plugs,
 * tariff, reliability: null, fetchedAt). Plug health is derived per rules.
 */
function liveStationView(station: import('@indeev/core').StatiqStationDetail) {
  const s = station;
  const summary = summarizeCcs2(s);
  return {
    stationId: s.stationId,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    address: s.address,
    city: s.city,
    hours: s.hours,
    openText: s.openText,
    rating: s.rating ?? null,
    reviewCount: s.reviewCount ?? null,
    reliability: null, // no verified reliability score exists
    ccs2: summary,
    chargers: s.chargers?.map((ch) => ({
      chargerId: ch.chargerId,
      name: ch.name,
      type: ch.type,
      kw: ch.kw,
      pricePerKwh: ch.pricePerKwh ?? null,
      lastUsedOn: ch.lastUsedOn ?? null,
      connectors: ch.connectors?.map((p) => ({
        connectorId: p.connectorId,
        type: p.type,
        status: p.status,
        available: p.available,
        note: p.note,
      })),
    })),
    amenities: s.amenities ?? [],
    stationUrl: s.stationUrl,
    navUrl: s.navUrl,
  };
}

// ---------------------------------------------------------------------------
// Mock mode: synthetic data for repeatable UI work (zero live calls).
// ---------------------------------------------------------------------------

function mockGeocode(q: string) {
  const places = [
    { name: 'Delhi', label: 'Delhi, India', lat: 28.6139, lon: 77.209, city: 'Delhi', state: 'Delhi', country: 'India' },
    { name: 'Jaipur', label: 'Jaipur, Rajasthan, India', lat: 26.9124, lon: 75.7873, city: 'Jaipur', state: 'Rajasthan', country: 'India' },
    { name: 'Mumbai', label: 'Mumbai, Maharashtra, India', lat: 19.076, lon: 72.8777, city: 'Mumbai', state: 'Maharashtra', country: 'India' },
    { name: 'Prayagraj', label: 'Prayagraj, Uttar Pradesh, India', lat: 25.4381, lon: 81.8338, city: 'Prayagraj', state: 'Uttar Pradesh', country: 'India' },
  ];
  const needle = q.trim().toLowerCase();
  return places.filter((p) => p.name.toLowerCase().includes(needle) || p.label.toLowerCase().includes(needle));
}

function mockPlan(
  origin: { label: string; lat: number; lon: number },
  destination: { label: string; lat: number; lon: number },
  resolved: ResolvedVehicle,
): TripPlan {
  const now = new Date().toISOString();
  return {
    id: `mock-${Date.now()}`,
    createdAt: now,
    origin,
    destination,
    vehicle: {
      label: resolved.label,
      catalogId: resolved.catalogId,
      batteryKwh: resolved.batteryKwh,
      claimedRangeKm: resolved.claimedRangeKm,
      realWorldRangeKm: resolved.realWorldRangeKm,
    },
    status: 'ok',
    source: 'synthetic',
    routeDistanceKm: 415.2,
    routeDurationMin: 432,
    geometry: [
      { lat: origin.lat, lon: origin.lon },
      { lat: (origin.lat + destination.lat) / 2, lon: (origin.lon + destination.lon) / 2 },
      { lat: destination.lat, lon: destination.lon },
    ],
    stops: [
      {
        station: mockStationView(9101, 'Statiq Highway Plaza', 195),
        chainageKm: 198,
        legKm: 198,
        detourKm: 0.4,
        arriveSocPct: 45,
        leaveSocPct: 52,
        chargeKwh: 5,
        pricePerKwh: 22,
        estPriceInr: 110,
        chargeTimeMin: 6,
        arrivalEtaMin: 206,
        departureEtaMin: 212,
      },
      {
        station: mockStationView(9102, 'Tata Power Charge Zone', 402),
        chainageKm: 405,
        legKm: 207,
        detourKm: 1.1,
        arriveSocPct: 46,
        leaveSocPct: 81,
        chargeKwh: 25,
        pricePerKwh: 21.5,
        estPriceInr: 538,
        chargeTimeMin: 26,
        arrivalEtaMin: 421,
        departureEtaMin: 447,
      },
    ],
    totals: {
      distanceKm: 415.2,
      driveTimeMin: 432,
      chargeTimeMin: 32,
      totalTimeMin: 464,
      chargeKwh: 30,
      estPriceInr: 648,
      finalSocPct: 64,
    },
    stationsSeen: 48,
    warnings: [],
  } as TripPlan;
}

function mockStationView(stationId: number, name: string, chainageKm: number) {
  // positions along the straight mock route for map rendering
  return {
    stationId,
    name,
    brand: name.toLowerCase().includes('tata') ? 'tata' : 'statiq',
    lat: 27.7 + chainageKm * 0.001,
    lon: 76.6 + chainageKm * 0.001,
    address: 'Highway side, NH 48',
    city: 'Kotputli',
    hours: '00:00 To 23:59',
    openText: 'Open Now',
    rating: 4.3,
    reviewCount: 128,
    reliability: null,
    fetchedAt: new Date().toISOString(),
    synthetic: true,
    amenities: ['Cafe', 'Restroom'],
    stationUrl: null,
    navUrl: null,
    chargers: [
      {
        chargerId: stationId * 10,
        name: `${name} DC 60`,
        type: 'DC',
        kw: 60,
        pricePerKwh: 22,
        lastUsedOn: '18/11/2026',
        plugs: [
          { connectorId: stationId * 100 + 1, type: 'CCS-2', health: 'working-free', contradiction: false },
          { connectorId: stationId * 100 + 2, type: 'CCS-2', health: 'working-occupied', contradiction: false },
        ],
      },
    ],
  };
}

function mockStation(id: number) {
  return {
    ...mockStationView(id, 'Statiq Mock Point', 120),
    ccs2: { total: 2, usable: 2, free: 1, occupied: 1, uncertain: 0, faulted: 0, offline: 0, maxKw: 60, pricePerKwh: 22, hasContradiction: false, isUsable: true },
  };
}
