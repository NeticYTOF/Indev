# Upstream request accounting (one planning run)

How many Statiq API requests a plan costs, what the run budget counts, and
what happens when the route outgrows it. This is the arithmetic to consult
before changing caps — the caps themselves are operator choices, never
silently raised.

## Anatomy of one live plan

For a route of `R` km:

| Phase | Upstream requests |
|---|---|
| Route | 0 (OSRM is a separate free service) |
| Corridor scan (markers) | `ceil(R / 12) + 1` sample points planned (one every 12 km plus the destination; consecutive samples overlap ~half of the ~13 km marker radius; a completed scan dispatches exactly this many) |
| Candidate details | 1 per **unique** corridor candidate (both detour bands, deduped by `stationId`, within-run memo reuse is free) |

The details phase is **exhaustive by owner directive**: every unique
candidate in both the primary (≤ 2 km off-route) and fallback (≤ 5 km
off-route) bands is checked via **individual per-station lookups with
multiple checks in flight** — no bulk endpoint, no window-based pruning, no
lazy skips. Selection still *prefers* the primary band and never detours
far for a brand, but it *consults* every fetched candidate.

### Examples

| Route | Markers | Details (OBSERVED, a246950 markers-only discovery) | Fits the 200-call / 4-min budget? |
|---|---|---|---|
| Delhi → Jaipur (~284 km) | 25 | **396 unique corridor candidates** (155 primary + 241 fallback) | **No** — fresh full coverage needs ≥ 421 calls (25 + 396, before retries), and at sustained pacing ~17.4 min; the honest outcome is `not_determined: budget-exhausted` / `deadline` |
| Mumbai → Prayagraj (~1432 km) | ~121 | unobserved (fresh-every-run; expect at least proportionally more) | **No** |

## Grounded discovery (Delhi → Jaipur, Linux markers-only run at a246950)

25/25 marker calls returned HTTP 200 in 48.674s, discovering 640 unique
listings → **396 corridor candidates** (155 primary + 241 fallback). Fresh
FULL coverage of this route therefore needs **≥ 421 actual calls before any
retry** (25 samples + 396 unique per-station lookups). That 396 is the
observed N for THIS corridor - never permission to freeze or stale-reuse
coverage: the every-candidate, live-only rule stands, and every run fetches
fresh. Under the existing 25-per-~62s rolling window + 2s start gap, the
421st dispatch arrives earliest at ~17 min 12.8 s - the current server
budget (200 calls / 4 min) and the standalone default (220 / 5 min) cannot
complete this work.

## Advisory work estimates (reporting only - never gates)

`work-estimate.ts` derives the remaining-work figures the planner appends to
`not_determined` evidence (`rough estimate: ~N more upstream calls remain…`).
Semantics, explicitly:

- **ADVISORY REPORTING ONLY.** Nothing gates execution on them; the owner
  policy is every-candidate-checked, and runs proceed until the budget /
  deadline is hit. There is no early refusal, no derived cause, no dispatch
  skipping.
- The wall figure is a **rough sustained-pacing estimate, not a strict
  finite-run bound**: the first dispatch is near-free and rolling-window
  credits shift the true schedule either way.
- Assumptions: one call per planned sample / unique candidate, zero retries
  (the client default is 2 and only adds), latency/backoff excluded.
- Model: `max(minCallGapMs, WINDOW_RETENTION_MS / maxCallsPerMinute)` =
  max(2s, 62s/25) = **2.48 s/call**, shared with the limiter via the
  exported `WINDOW_RETENTION_MS` so the two can never drift.

## Explicit budget overrides (available - NOT enabled)

A future coordinated acceptance can explicitly choose a bounded envelope
after fresh N is known, via launch env (validated at boot, loud on error,
never silently clamped):

- `INDEV_PLAN_MAX_CALLS` (integer 1..10,000)
- `INDEV_PLAN_DEADLINE_MS` (integer 10s..6h)
- `INDEV_PLAN_RETRIES` (integer 0..3; zero-retry gives exact call accounting)

Absent = the `SERVER_RUN_BUDGET` defaults, byte-identical to before. The
acceptance runner's fetch wall adapts only when the deadline override is
present (deadline + 30s slack). `/api/health` reports the effective envelope
for introspection. Nothing is enabled by this mechanism alone - an owner-
approved run must supply the values explicitly.

**Preserved policy positions** (unchanged by the estimator work): a run
whose call count fits but whose wall does not still ATTEMPTS until the
authoritative deadline abort and reports `not_determined: deadline`, with
the advisory estimate explaining the mismatch in the evidence; raising the
envelope for a specific route is an explicit operator decision, never
automatic.

## What the run budget counts

The budget (`UpstreamBudget`, see `packages/core/src/upstream-budget.ts`)
is a **hard cap on actual transport attempts**, shared by everything in one
planning run:

- **dispatch-accounting**: an attempt is reserved ATOMICALLY immediately
  before its dispatch (after the paced limiter permit, with no await
  between a successful reservation and the fetch), so
  **reserved == dispatched** — the counters always match real network work.
  Waiting callers reserve nothing up front: no pacing wait can be
  retroactively cancelled by another waiter;
- **cap exhaustion is per-caller, never run-fatal**: a caller that finds no
  room is refused without dispatching, while work already reserved by other
  callers proceeds. (A past reservation race let N>cap concurrent callers
  globally stop the run before anyone dispatched — actual 0, reported N —
  fixed and regression-tested);
- a **fatal stop** (first 429 throttle / 401/403 auth) is run-global: every
  caller fails fast at the recheck, with zero NEW dispatch after the stop;
- **in-client 5xx retries count too**: a flaky gateway consumes real
  attempts, not just logical calls;
- memo hits (a station examined twice in one run, within the 90 s TTL)
  are free — no traffic, no budget consumption;
- the cap is enforced at the client for real `StatiqClient`s; duck-typed
  test doubles fall back to logical per-dispatch counting (same semantics
  when no retries happen).

Defaults: server `SERVER_RUN_BUDGET` and MCP `MCP_RUN_BUDGET` are both
`200` attempts / **4 minutes** deadline; the planner's own default is
`220 / 5 min` for library use. Changing these is an explicit operator
decision — code never raises them silently.

## Fail-closed stop semantics

- **First 429 (throttle) or 401/403 (auth)**: the whole run stops instantly
  — no sleep-then-retry, no bypassing the server's limit. Concurrent
  workers fail fast at the budget gate **without touching the network**.
  The parsed `Retry-After` (both the delay-seconds and the HTTP-date form)
  is recorded and reported so the next run can be scheduled honestly.
- **Exhausted budget**: the plan fails as `not_determined` with coverage
  evidence — attempts used vs cap (actual transport attempts, incl.
  retries), route samples covered, and the candidate aggregate (planned
  unique pool / processed / detailed / remaining, recorded before the
  details phase starts and updated with each completed lookup), plus
  phase timings (scan wall time, details elapsed). This is **coverage
  undetermined — never a verdict that the route is impossible**, and never
  silent confidence. The HTTP response is 422 with `code: "not_determined"`
  and a cause (`budget-exhausted`, `throttled`, `auth`, `deadline`,
  `sample-throttled`, `scan-coverage`).
- **Completed ≠ dispatched (terminology)**: the scan-evidence line reads
  `route samples covered OK/COMPLETED of N planned` — COMPLETED counts
  sample RESPONSES received (ok or failed). In-flight samples and samples
  unwound by a fatal stop are neither completed nor dispatched-counted;
  completed is never presented as the dispatch count. The ACTUAL upstream
  attempt figure is always the separate `N of M upstream attempts` count
  from the run budget (reserved == dispatched, retries included).
- **Deadline**: same honest `not_determined: deadline`.

## Pacing (project safety defaults - NOT a provider contract)

The rolling window limiter enforces **25 calls / 60 s** with a **2 s minimum
gap** between dispatches. These are CONSERVATIVE PROJECT SAFETY DEFAULTS -
our own politeness choice, not a contract the upstream publishes or that
we rely on rate headers for.

### Concurrency evidence (offline harness, Linux)

The candidate phase runs individual per-station lookups with a few checks
in flight (`pMap(4)`); the corridor scan likewise. Offline harness runs
(latency shaped like the replica) show what concurrency does and does NOT
do:

| Harness | Workers | Wall time | Max in flight |
|---|---|---|---|
| 40 ms latency, 200 ms gaps, 12 calls | 3 | ~2244 ms | 1 |
| 40 ms latency, 200 ms gaps, 12 calls | 100 | ~2242 ms | 1 |
| 600 ms latency | 3 | ~2955 ms (overlap) | >1 |

Multiple checks in flight let upstream LATENCY overlap the pacing gap -
that is all. They **never reduce the request count**, **never remove
pacing**, and with short replica latency at most one request is actually
in flight. The limiter alone decides pace.

### CPU cost context (offline, synthetic geometry)

Synthetic-geometry processing costs are negligible against the network
span: ~3 ms at 100×1000 points, ~74 ms at 500×5000, ~298 ms at 1000×10000 -
versus ~236 s of live network span for a full run. These are isolated
measurements, not a full run CPU profile; no speculative rewrite (e.g. to
native code) is warranted by them.

## Instrumentation

- Per-attempt sanitized audit: `seq`, endpoint (e.g. `stations/markers`),
  HTTP status, ISO timestamp — never headers, coordinates or bodies.
- Per-run summary audit: outcome string (e.g. `ok`,
  `not_determined:throttled`, `not_determined:budget-exhausted`) plus the
  actual upstream call count.
