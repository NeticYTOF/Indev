# IndEV potholes

Last updated: 22 November 2026, 03:21 IST

This is the project issue ledger, not a claim that the app is finished. "Verified offline" means tests or source inspection passed. It does not mean a live route completed or a charger was physically checked.

## Current state

- Latest verified published baseline: [`e87e476`](https://github.com/NeticYTOF/Indev/commit/e87e476ccf6a8069b94ad30af09f3694b2a0264d).
- That baseline passes 1,197 repository tests in 75 files, application/browser type checks and the web build.
- A genuine completed live route and its uncut, normal-speed screen recording are still missing.
- The latest live Delhi to Jaipur run examined 35 of 378 candidate stations. None of those 35 was certified under the active working-CCS2 and 60 kW rules. The other 343 were unchecked. This is an incomplete search, not proof that the route has no usable charger.
- Reserve/charge-to parity is being corrected and independently tested. It is not yet published or accepted as complete.

## Open blockers

### P-01: Connector status and fault text can contradict each other

**Status: open, data contract unresolved.**

Observed example: station 5209's normalized details reported available connectors while carrying a positive fault note. Its official station page separately displayed the 60 kW CCS2 connector as charging and the 360 kW connectors as available.

The shipped Statiq CSMS client renders connector last-recorded status, info and error code separately. Connector color follows status. This establishes how that client presents data, not how the public API's `error_message` maps to those fields or whether a reported error has cleared.

Still unknown:

- Whether `error_message` is an active error or a previous error.
- Whether it belongs to the connector, charger or a broader unit.
- Which timestamp establishes the underlying observation time and error-clear time.
- Which field should take precedence when status and error text disagree.

A recent HTTP response is not proof of recent hardware telemetry. Do not label the fault harmless or certify the connector from its display color. Conflicting evidence remains uncertain.

Sources:

- https://www.statiq.in/rj-neemrana-hotel-highway-king-ev-charging-station-id-5209
- https://csms.statiq.in/
- https://csms.statiq.in/static/js/7984.66667ce3.chunk.js.map

**Exit condition:** an authoritative field mapping plus observation/clearing semantics, or equivalent reliable current connector evidence. No operator contact has been made.

### P-02: Live route completion has not been demonstrated

**Status: open, acceptance missing.**

The last recorded run reached a failed terminal state after approximately 137 seconds. It made 24 marker requests and 35 detail requests, all recorded as HTTP 200, but found no certified station in the checked subset. HTTP success alone therefore does not solve the charger-evidence problem.

Its model made nine completed responses, but the final response was invalid JSON. This is separate from charger eligibility. No successful route or successful recording should be inferred from completed model responses, passing tests or published code.

**Exit condition:** a fresh, genuine Delhi to Jaipur route completes with the intended vehicle, starting charge, hard 60 kW cap, working CCS2 policy and reserve/range checks intact. Capture the actual run uncut at normal speed. No replay, mocks, accelerated footage or tests-only substitute.

### P-03: Search limits leave material coverage unknown

**Status: bounded coverage implemented; route-level uncertainty remains.**

The standard profile admits at most 20 unique detail IDs. The optional server-selected progressive profile admits at most 40. The progressive run settled 35 checks and left 343 candidates unchecked.

Increasing the allowance from 20 to 40 did not produce a certified route. Do not turn an exhausted allowance into an impossibility verdict, silently raise request rates, or describe partial diagnostic samples as the whole run.

**Exit condition:** a certified feasible sequence, or a truthful not-determined outcome showing remaining coverage. Full-route impossibility needs sufficient evidence, not merely an exhausted model/tool allowance.

## Reserve and charge-to parity work

### P-04: Original explicit settings were absent from the fresh HTTP API

**Status: implementation and audit in progress, not published.**

Verified original semantics:

- `reservePct`: explicit range 0 through 49.
- `targetSoc`: explicit charge-to range 15 through 100 and at least `reservePct + 5`.
- Target means departure charge at each charging stop. It is not a destination-arrival setting or merely an upper limit.

The fresh build must keep its existing behavior when fields are absent: arrival reserve 10%, usual stop level 80%, absolute charging limit 95% and minimal necessary charging. Restoring an explicit 100% option must not change those defaults.

Required wiring includes all three planning HTTP paths, core greedy selection, model-choice validation, final stop assembly, energy/time/cost accounting, advisory reachability and effective limits sent to the model. Browser request types do not establish that controls exist in the UI.

### P-05: Clamped battery helpers cannot prove a zero-reserve leg is possible

**Status: caught before publication; uncapped feasibility corrections under audit.**

`socAfterDriving` floors its result at zero. Comparing that display value against a zero reserve would accept even an energy-deficient leg. Example under the current Harrier working estimates: starting at 50%, a 285 km leg needs roughly 70% of usable energy. A displayed zero is not a feasible arrival.

Likewise, a helper that caps required departure charge at 100 cannot prove that a leg actually needs no more than 100.

**Required fix:** use unfloored/uncapped energy checks at each leg, including zero-stop decisions, greedy selection, model validation, destination checks and advisory guidance. Keep display clamping separate from feasibility evidence.

### P-06: Explicit low targets must neither overcharge silently nor discard carried energy

**Status: corrections under audit.**

Two different mistakes need protection:

1. A requested 15% departure target cannot silently become 95% to make a later leg work. Reject an insufficient target instead.
2. If a vehicle arrives above its requested target, do not discharge it or charge negative energy. Preserve that arrival energy when checking later legs.

An independent greedy case exposed a false rejection: starting at 100%, stopping near 100 km and continuing another 250 km can be feasible on retained energy even with an explicit 15% target. Checking the final leg against a fictitious discharged 15% is wrong.

### P-07: Option propagation can diverge from actual planning rules

**Status: caught before publication; corrections under audit.**

Interim implementation review found that the selective runner still sent default 10%/95% effective limits despite a request for reserve 20% and target 60%. The final validator and model/advisory views must use the same resolved settings.

Another interim default represented absent reserve as explicit zero. Resolving those options again could then change the intended default reserve from 10% to 0%. Absence must remain distinct from an explicit zero.

**Exit condition for P-04 through P-07:** the exact final source passes repository tests, independent boundary/integration checks, type checks and build checks before publication. A passing old suite alone is not enough.

### P-08: Charging estimates are not validated vehicle physics

**Status: known limitation, must remain disclosed.**

The vehicle model contains generic working estimates for usable capacity, consumption, charging power and taper. The taper is defined through 100%; that permits a finite estimate within that model, not a claim that real charging to 100% follows the same curve.

Do not extrapolate beyond 100%, invent a verified vehicle curve, or call estimated times physically validated. Any explicit high-target result must preserve that distinction.

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

## Acceptance rules

1. Keep the hard 60 kW cap and verified-working CCS2 policy. An occupied working connector may remain an option; occupancy does not establish a fault and is not provided to the planning model.
2. Preserve range, reserve, energy, charging-time and tariff honesty. Unknown price is not free charging.
3. Keep repository test counts separate from additional independent audit cases.
4. Publish only the intended files, with no credentials or unrelated pending changes.
5. Close the live-route and recording gap only with actual successful execution evidence.
