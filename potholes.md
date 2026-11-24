# IndEV potholes

Last updated: 22 November 2026

This is the project issue ledger, not a claim that the app is finished. "Verified offline" means tests or source inspection passed. It does not mean a live route completed or a charger was physically checked.

## Current state

- Latest verified published implementation: [`09c17b3`](https://github.com/NeticYTOF/Indev/commit/09c17b35dda01e7582ffef7eb7d29b743b4c8372). Earlier commits remain historical implementation milestones.
- Fresh public-clone offline audit of `09c17b3`: 1,315 repository tests across 85 files; separately, 92 independent cases across 8 files. Complete application/browser type checks and the web build passed with the known bundle-size warning only. These counts are separate offline checks, not a combined total or live success.
- A genuine completed live route and its uncut, normal-speed screen recording are still missing.
- The latest recorded genuine run remains historical: it was accepted 22 November 2026 at 14:03:05 IST on the earlier `fa03562` implementation and ended not-determined about 14:05:40. It used the same Delhi–Jaipur route, default Harrier 75 kWh, 50% start, hard 60 kW cap, effective reserve 10%, 300 km max leg, default max 95%, unchanged progressive40, and the same Hack Club GLM 5.3 Flash. A specifically reconciled one-time IDs-only import supplied 37 proven historical completed-check IDs for selection bookkeeping only; it carried no old freshness, health, details, timestamps, or older 35-ID union, and did not broaden ordinary scope matching.
- That run discovered 378 current candidates and completed 21 successful fresh detail checks; all 21 IDs were new relative to the imported history. There were zero successful revisits and zero certified stops. Host outcomes were 7 policy_fault_note, 13 no_usable_ccs2, and 1 not_within_cap. This is real novelty evidence, not 40-new coverage, optimum selection, or route impossibility. 357 candidates were not successfully checked THIS run; do not call 320 unchecked because the historical/current inventory intersection was not retained.
- Reserve/charge-to parity was published in [`79157a6`](https://github.com/NeticYTOF/Indev/commit/79157a6948e4d848a735b9060078cebbef281c58). The available-status positive-fault planning policy was published in [`a880aa1`](https://github.com/NeticYTOF/Indev/commit/a880aa1aade418c96169ab9b56de3a4f9e9af7e2). Vehicle charging-time estimates remain unvalidated physics.
- Actual-road certification for the selected final sequence was published in [`d9f9b91`](https://github.com/NeticYTOF/Indev/commit/d9f9b917635f02c86fdb4f9331535bb325e8a0b7): 1,233 repository tests plus 22 independent cases passed in its fresh public audit.
- The parse-only `/api/ai/parse` backend was published in [`6a7c99f`](https://github.com/NeticYTOF/Indev/commit/6a7c99f877d6161b34fff527054b28272ab6f342), and the tool-free final JSON-object hint in [`baf5518`](https://github.com/NeticYTOF/Indev/commit/baf551819f18bd970ead39ee246b2ea9529f2c0c). Neither establishes end-to-end natural-language planning or live success.
- IDs-only checked-station history was published as the storage commit `e1b2296` and integration commit `fa03562`. It independently reloads 58 IDs with 0600 permissions and only version/scopeKey/checkedIds; failed or interrupted IDs are not persisted. Synthetic offline traces showed adaptive requests could reach 40 fresh checks within unchanged bounds while the unchanged 33-old/4-new trace made 4 fresh checks and 33 deferrals; explicit refresh is intent, not verified necessity. That real run supplied independent novelty evidence but no charger, coverage, AI-cooperation, or route-success guarantee.
- Native isolated-detail recovery for ECONNRESET, HTTP 500, or inner timeout already existed: only that ID becomes unknown, completed fresh evidence is retained, other IDs may continue within unchanged limits, the failed ID is memoized against retry, and it is excluded from certification/history. The prior full-stop came from a separate private acceptance-control blanket rule, not the whole-bulk product defect or a proven network-origin diagnosis. The reset origin remains unknown. The classified private control now permits only isolated detail-availability failure recovery within unchanged limits; auth, throttle, protocol and global failures remain fatal. Failed IDs stay unknown, with no same-item retry or stale certification. The separate product whole-bulk propagation fix is published in `09c17b3`: a thrown whole-call failure unwinds with its original cause and confirmed progress, without synthetic failures or completions for unconfirmed batches. No new live run, model/limits/retries/rates change, complete route, or real-success recording is claimed.

## Open blockers

### P-01: Connector status and fault text can contradict each other

**Status: planning policy set; underlying data contract still unresolved.**

Observed example: station 5209's normalized details reported available connectors while carrying a positive fault note. Its official station page separately displayed the 60 kW CCS2 connector as charging and the 360 kW connectors as available.

The shipped Statiq CSMS client renders connector last-recorded status, info and error code separately. Connector color follows status. This establishes how that client presents data, not how the public API's `error_message` maps to those fields or whether a reported error has cleared.

Still unknown:

- Whether `error_message` is an active error or a previous error.
- Whether it belongs to the connector, charger or a broader unit.
- Which timestamp establishes the underlying observation time and error-clear time.
- Which field should take precedence when status and error text disagree.

A recent HTTP response is not proof of recent hardware telemetry. Do not label the fault harmless or certify the connector from its display color. Conflicting evidence remains uncertain.

Owner policy (23 November 2026, supersedes 22 November): when an `available` connector carries a positive fault message and availability is not explicitly false, **status wins for planning**: the plug is planned as usable, its observed health stays `uncertain`, and it carries `faultNote: positive_fault_with_available_status`. Every chosen stop whose usable plugs all carry that note gets a visible plan warning and an "Available, but fault reported" chip. Reason: a live probe of the Delhi–Ahmedabad corridor found 32 of 58 sampled connectors returning `available` / `true` / `Faulted`. Excluding them made a drivable 978 km route report "infeasible"; with this policy it plans with 4 warned stops.

Previous owner policy (22 November 2026, 04:28 IST, superseded): when an `available` connector carries a positive fault message, the planner records `positive_fault_with_available_status` and treats the plug as faulted for planning only. This is an explicit planning choice for the 5209/7519 conflict class, not proof of a physical fault, a station blacklist, or permission to discard healthy sibling connectors. Raw status, note, provenance and contradiction evidence are preserved; occupied working connectors remain usable under the existing rule.

Sources:

- https://www.statiq.in/rj-neemrana-hotel-highway-king-ev-charging-station-id-5209
- https://csms.statiq.in/
- https://csms.statiq.in/static/js/7984.66667ce3.chunk.js.map

**Exit condition:** an authoritative field mapping plus observation/clearing semantics, or equivalent reliable current connector evidence. No operator contact has been made.

### P-02: Live route completion has not been demonstrated

**Status: open, acceptance missing.**

The newest run on `fa03562` ended not-determined. It used the exact Delhi–Jaipur route, default Harrier 75 kWh, 50% start, hard 60 kW cap, effective reserve 10%, 300 km max leg, default max 95%, progressive40, and the same GLM 5.3 Flash. Its one-time IDs-only import carried 37 proven historical completed-check IDs for bookkeeping only, with no old health, details, timestamps, or scope broadening. It discovered 378 current candidates and completed 21 successful fresh detail checks, all new relative to that import; zero were successful revisits and zero chargers were certified. Host outcomes were 7 policy_fault_note, 13 no_usable_ccs2, and 1 not_within_cap. 357 candidates were not successfully checked this run; the historical/current intersection was not retained, so 320 unchecked is not a supported claim.

Wire accounting was 24 actual gateway HTTP requests: two bulk-marker requests covering 24 samples, 21 detail requests with HTTP 200, and one later detail dispatch that failed with read ECONNRESET before HTTP headers. SDK audit reported 49 logical provider units (24 samples plus 25 attempted details), 45 HTTP 200 units, and 4 failure records: one actual reset and three locally blocked attempts. After the first external failure, the private external guard blocked the three remaining detail attempts in the admitted batch and the next model attempt; those blocks were local, not remote failures or retries. Five actual model responses all ended in tool_calls; a sixth normal-turn attempt was locally blocked, and no final turn or answer was reached. This run does not test the final JSON-format fix. Provider-reported model cost was 0.00707288 and 138,976 tokens, with currency/unit unverified and gateway charges unknown. The reset cause is unknown: no HTTP response proves auth, throttling, or server failure, and wall/monotonic divergence is not evidence of cause. The older invalid ninth-JSON run and 35-detail run remain historical.

The native UI ultimately showed a generic AI tool request failure after the guard blocked the next model attempt; native UI wording is not repaired. The earlier 19-case private acceptance-observer revision was a historical accounting correction: it separated wire dispatches from local blocks, preserved the product outcome, kept body promises free of eager reads, and covered cancellation/cleanup, strict-detail contract failure, HTTP/body errors, observer failures, concurrent already-dispatched requests, per-run isolation, and wall-clock labels versus monotonic duration. It still retained the blanket stop after the first observed external error and is superseded. The classified private control is now qualified with 28 focused offline cases: it keeps the first observed failure separate from the first fatal failure, allows only isolated detail-availability recovery without same-item retry, and never overrides a failed product outcome or cancellation with success. Auth, throttle, protocol and global failures remain fatal. The 92 independent product cases include 29 actual-native cases covering the old-gate versus classified-gate sync/job comparison. The 28 current private-control cases and 19 historical comparison cases are separate from both the 1,315 repository tests and the 92 independent product cases. No combined total or live success is claimed. The reset origin remains unknown, native UI wording remains unrepaired, both owned services and the browser were stopped, the 182.80-second original uncut failed recording remains private, and no second run or retry was made.

**Exit condition:** a fresh, genuine Delhi to Jaipur route completes with the intended vehicle, starting charge, hard 60 kW cap, working CCS2 policy and reserve/range checks intact. Capture the actual run uncut at normal speed. No replay, mocks, accelerated footage or tests-only substitute.

### P-03: Search limits leave material coverage unknown

The standard profile admits at most 20 unique detail IDs; progressive40 admits at most 40, unchanged for the newest run. That run completed 21 successful fresh detail checks among 378 discovered candidates, with 357 not successfully checked this run; three further admitted attempts were blocked locally after the single external reset. The imported IDs-only history was a bookkeeping aid, not a broader scope or a claim of current health. A thrown whole-call bulk failure is not a per-sample coverage hole; it unwinds with earlier completed progress intact. Earlier 37-check and 35-check runs remain historical. Do not turn bounded or interrupted coverage into an impossibility verdict, silently raise request rates, or describe partial diagnostic samples as the whole run.

**Exit condition:** a certified feasible sequence, or a truthful not-determined outcome showing remaining coverage. Full-route impossibility needs sufficient evidence, not merely an exhausted model/tool allowance.

## Reserve and charge-to parity work

### P-04: Original explicit settings were absent from the fresh HTTP API

**Status: published in [`79157a6`](https://github.com/NeticYTOF/Indev/commit/79157a6948e4d848a735b9060078cebbef281c58); live route success still outstanding.**

Verified original semantics:

- `reservePct`: explicit range 0 through 49.
- `targetSoc`: explicit charge-to range 15 through 100 and at least `reservePct + 5`.
- Target means departure charge at each charging stop. It is not a destination-arrival setting or merely an upper limit.

The fresh build must keep its existing behavior when fields are absent: arrival reserve 10%, usual stop level 80%, absolute charging limit 95% and minimal necessary charging. Restoring an explicit 100% option must not change those defaults.

Required wiring includes all three planning HTTP paths, core greedy selection, model-choice validation, final stop assembly, energy/time/cost accounting, advisory reachability and effective limits sent to the model. Browser request types do not establish that controls exist in the UI.

The published implementation passed 1,219 repository tests plus 22 independent audit cases before the commit and 1,219 repository tests in the fresh public audit. The 100% charge option is allowed only as a user-selected explicit target; the taper-to-100 estimate remains a working model, not validated vehicle physics.

### P-05: Clamped battery helpers cannot prove a zero-reserve leg is possible

**Status: resolved in published [`79157a6`](https://github.com/NeticYTOF/Indev/commit/79157a6948e4d848a735b9060078cebbef281c58).**

`socAfterDriving` floors its result at zero. Comparing that display value against a zero reserve would accept even an energy-deficient leg. Example under the current Harrier working estimates: starting at 50%, a 285 km leg needs roughly 70% of usable energy. A displayed zero is not a feasible arrival.

Likewise, a helper that caps required departure charge at 100 cannot prove that a leg actually needs no more than 100.

**Required fix:** use unfloored/uncapped energy checks at each leg, including zero-stop decisions, greedy selection, model validation, destination checks and advisory guidance. Keep display clamping separate from feasibility evidence.

### P-06: Explicit low targets must neither overcharge silently nor discard carried energy

**Status: resolved in published [`79157a6`](https://github.com/NeticYTOF/Indev/commit/79157a6948e4d848a735b9060078cebbef281c58).**

Two different mistakes need protection:

1. A requested 15% departure target cannot silently become 95% to make a later leg work. Reject an insufficient target instead.
2. If a vehicle arrives above its requested target, do not discharge it or charge negative energy. Preserve that arrival energy when checking later legs.

An independent greedy case exposed a false rejection: starting at 100%, stopping near 100 km and continuing another 250 km can be feasible on retained energy even with an explicit 15% target. Checking the final leg against a fictitious discharged 15% is wrong.

### P-07: Option propagation can diverge from actual planning rules

**Status: resolved in published [`79157a6`](https://github.com/NeticYTOF/Indev/commit/79157a6948e4d848a735b9060078cebbef281c58).**

Interim implementation review found that the selective runner still sent default 10%/95% effective limits despite a request for reserve 20% and target 60%. The final validator and model/advisory views must use the same resolved settings.

Another interim default represented absent reserve as explicit zero. Resolving those options again could then change the intended default reserve from 10% to 0%. Absence must remain distinct from an explicit zero.

**Gate completed for P-04 through P-07:** 1,219 repository tests plus 22 independent cases before publication, then 1,219 repository tests in the fresh public audit; type checks and web build passed. A passing old suite alone was not enough.

### P-08: Charging estimates are not validated vehicle physics

**Status: known limitation, must remain disclosed.**

The vehicle model contains generic working estimates for usable capacity, consumption, charging power and taper. The taper is defined through 100%; that permits a finite estimate within that model, not a claim that real charging to 100% follows the same curve.

Do not extrapolate beyond 100%, invent a verified vehicle curve, or call estimated times physically validated. Any explicit high-target result must preserve that distinction.

### P-09: Selected legs must be certified on actual roads

**Status: Published in [`d9f9b91`](https://github.com/NeticYTOF/Indev/commit/d9f9b917635f02c86fdb4f9331535bb325e8a0b7); fresh public audit: 1,233 repository tests plus 22 independent cases, with application/browser type checks and the web build passing (22 November 2026).**

The original planner routed every candidate-to-stop leg, every chosen stop leg and the final leg with OSRM. The fresh planner estimated stop-to-stop distance from route chainage plus straight-line off-route distance and routed only origin to destination. A river, one-way system or barrier can make the actual road leg longer than that estimate while the straight-line number still passes 300 km, reserve and energy checks.

The correction routes only the final selected sequence, aggregates via segments into charging-to-charging energy legs, uses actual routed distance and duration for range, reserve, charge-to, final SoC, ETAs and totals, preserves via order, and fails closed on ambiguous or incomplete road certificates. It adds no candidate fanout, automatic retries beyond the scoped zero-retry leg option, new AI turns or rate/budget increases.

The public archive for `d9f9b91` independently matched all 22 staged blobs; 1,233 repository tests plus 22 independent cases, application/browser type checks and the web build passed. This does not establish a live route. The 37-check/341-unchecked run is now historical; P02 records the actual newer 21-new interrupted run and its limits. Physical charger status uncertainty is unchanged.

## Verified published corrections

These are code/test improvements, not proof of live route success.

| Change | Published evidence | What remains limited |
| --- | --- | --- |
| Typed no-fit handling and tool admission/coverage counters | [`e87e476`](https://github.com/NeticYTOF/Indev/commit/e87e476ccf6a8069b94ad30af09f3694b2a0264d) | No-fit cannot create a successful plan; invalid output still fails. It does not fix connector data. |
| Optional progressive coverage profile | [`6582118`](https://github.com/NeticYTOF/Indev/commit/65821183d914dbcf9d996ae77e49c1a58c8d3bf7) | Default profile unchanged. More checks did not establish a working route. |
| Power-rejection feedback and broader candidate ordering | [`53513c0`](https://github.com/NeticYTOF/Indev/commit/53513c09f4b59c1926fc4a91ca13bd6ce329b08e) | Advisory ordering is not charger certification. |
| Initial and connected-frontier reachability guidance | [`51a0eab`](https://github.com/NeticYTOF/Indev/commit/51a0eab9257396ef2f02f483d9199a28ed0bbf61) | Marker chainage and estimated detours are not proof of a drivable road spur. |
| Sanitized connector evidence for diagnosis | [`823be86`](https://github.com/NeticYTOF/Indev/commit/823be8697fabcb27eecca37354f1d061694b13a2) | Sample omissions remain explicit; raw payloads are not needed to call a run successful. |
| Narrow fault-language classification correction | [`5439aaa`](https://github.com/NeticYTOF/Indev/commit/5439aaa0c55858f5e8d61d2750c50437afcbbd7b) | Positive contradictory fault evidence is still not ignored. |
| Bounded final-output shape recovery | [`447403f`](https://github.com/NeticYTOF/Indev/commit/447403f0ef05ebfea3fb1a1e5147e12e10fb13b7) | Recovery is bounded; malformed prose is not accepted as a route. |

## Approaches that did not settle the problem

- Repeating live route attempts did not resolve the conflicting charger contract. Further speculative live loops are paused.
- Raising detail coverage alone did not yield a certified route.
- Official display behavior narrowed the question but did not establish error freshness, scope or clearing semantics.
- General OCPP documentation did not establish Statiq's public field mapping.
- A direct raw-marker request and a later raw station-page retrieval returned 403. Those blocked paths were stopped, not retried or bypassed. The exact origin of the marker-request denial remains unresolved.
- Successful model responses did not guarantee a valid final structured answer.
- Dirty local files are not evidence that a feature is unpublished. Export and saved-plan features already existed in the published build; duplicating them would not close a real parity gap.
- The 14:03 `fa03562` run demonstrated 21 genuinely fresh, host-ineligible checks with no successful revisits and no certified charger; a local external guard stopped residual attempts. It did not reach a final answer, prove optimal selection, establish a whole-route verdict, or fix the UI error wording.

## Acceptance rules

1. Keep the hard 60 kW cap and verified-working CCS2 policy. An occupied working connector may remain an option; occupancy does not establish a fault and is not provided to the planning model.
2. Preserve range, reserve, energy, charging-time and tariff honesty. Unknown price is not free charging.
3. Keep repository test counts separate from additional independent audit cases.
4. Publish only the intended files, with no credentials or unrelated pending changes.
5. Close the live-route and recording gap only with actual successful execution evidence.

## Qualification: bounded output-limit recovery and compact planner feedback

- The backend now allows one explicitly additional model-output attempt when an output-limit cutoff occurs and another normal turn slot remains. It is a counted model attempt, not a concealed retry of the same content. No automatic transport or station retries were introduced; the counted output-limit recovery is itself an additional provider request. No final-turn allowance, token ceiling, tool/fetch ceiling, pacing or call budget is increased.
- Truncated output is discarded before final-contract or station-selection handling: no partial IDs, tool calls, station facts, certification or history entry can come from it. Repeated cutoff, reserved-final cutoff, exhausted normal slots, cancellation between attempts, fatal non-output provider errors, and malformed recovered final/tool payloads are bounded terminal paths; a complete valid tool request may resume ordinary planning under existing checks.
- The initial model message remains authoritative for every current candidate, its exact fields, prior/current-new history semantics and complete advisory guidance. Guidance deltas are relative to the initial guidance; history deltas are successive progress updates. Every changed guidance field, including changed item lists and certified-chain count, is represented so the current guidance can be reconstructed without repeating unchanged payloads.
- A synthetic 378-candidate/58-prior-ID serialization comparison measured first-request bytes 34,735 to 35,056 (+321) and second-request bytes 44,982 to 37,275 (-7,707). Per zero-fact deferral feedback fell from 4,635 to 813 bytes. These are synthetic serialized byte counts, not live payload sizes, tokenizer usage, model-quality proof or evidence of higher live success.
- Offline qualification: 1,323 public repository tests across 87 files; separately, 55 independent cases across 3 files covered cutoff, reset and lossless-contract behavior. Application and browser type checks and the web build passed with the existing large-chunk warning. A genuine completed route and normal-speed recording remain unverified; no live-success claim is made.
