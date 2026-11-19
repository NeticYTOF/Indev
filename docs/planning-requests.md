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
| Corridor scan (markers) | `ceil(R / 12) + 1` calls (one sample every 12 km plus the destination; consecutive samples overlap ~half of the ~13 km marker radius, and every sample is attempted) |
| Candidate details | 1 per **unique** corridor candidate (both detour bands, deduped by `stationId`, within-run memo reuse is free) |

The details phase is **exhaustive by owner directive**: every candidate in
both the primary (≤ 2 km off-route) and fallback (≤ 5 km off-route) bands
is fetched in one bounded-parallel batch — no window-based pruning, no lazy
skips. Selection still *prefers* the primary band and never detours far for
a brand, but it *consults* every fetched candidate.

### Examples

| Route | Markers | Details (typical corridor) | Fits the 200-attempt budget? |
|---|---|---|---|
| Delhi → Jaipur (~284 km) | ~25 | ~10–40 | Yes, with headroom |
| Mumbai → Prayagraj (~1432 km) | ~121 | ~40–80 | **No** — honest `not_determined: budget-exhausted` is the expected outcome until the operator raises the cap |

## What the run budget counts

The budget (`UpstreamBudget`, see `packages/core/src/upstream-budget.ts`)
is a **hard cap on actual transport attempts**, shared by everything in
one planning run:

- every transport attempt reserves a slot **before** it can dispatch —
  nothing may slip past the cap;
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
  evidence (attempts used, samples covered, candidate details fetched).
  This is **coverage undetermined — never a verdict that the route is
  impossible**, and never silent confidence. The HTTP response is 422 with
  `code: "not_determined"` and a cause (`budget-exhausted`, `throttled`,
  `auth`, `deadline`, `sample-throttled`, `scan-coverage`).
- **Deadline**: same honest `not_determined: deadline`.

## Pacing (unchanged)

A rolling window limiter enforces **25 calls / 60 s** with a **2 s minimum
gap** between dispatches. Parallel batches (corridor scan and candidate
details both run `pMap(4)`) queue at the limiter: concurrency only keeps
the limiter fed — no dead time between dispatches — and never raises QPS.

## Instrumentation

- Per-attempt sanitized audit: `seq`, endpoint (e.g. `stations/markers`),
  HTTP status, ISO timestamp — never headers, coordinates or bodies.
- Per-run summary audit: outcome string (e.g. `ok`,
  `not_determined:throttled`, `not_determined:budget-exhausted`) plus the
  actual upstream call count.
