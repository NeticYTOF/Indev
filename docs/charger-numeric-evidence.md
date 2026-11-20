# Charger numeric evidence

Connector health and charger numeric metadata are separate evidence. An
available CCS2 DC connector is not a verified positive-power charger merely
because its status says available.

- Known power is a finite positive number on a usable CCS2 DC charger.
- Zero, negative, string and nonfinite power values are malformed evidence,
  not zero-minute charging and not a known faulted/offline connector.
- A valid usable sibling charger can still support a plan. The maximum known
  valid power and its own tariff stay paired. Malformed or missing sibling
  power leaves a warning without erasing the valid charger evidence.
- If a candidate has usable connectors but only malformed or malformed-plus-
  missing power, its timing evidence is unknown. Planning keeps that candidate
  as an evidence hole. A required unsupported stop yields not_determined,
  not a certified impossible route and not a fabricated charging time.
- Legacy absent-only power retains the pre-existing 50 kW estimate, now named
  in the plan warnings. This is a model estimate, not verified station power.
  Invalid present values never enter that missing-only fallback.
- A selected charger's tariff must be finite numeric and nonnegative. Zero
  remains a real zero tariff. Null, absent or malformed values remain unknown;
  another charger's tariff is never borrowed. Unknown stop costs keep the trip
  total unknown. Arithmetic overflow cannot become a confident finite total.

A plan with a justified known route can still be delivered around candidate
holes, but its scan-integrity status is degraded. This also applies to a
successful no-stop trip: reachability does not prove complete charger
coverage. A malformed sibling with valid known station power, or an unknown
tariff alone, is not a whole-candidate coverage hole. Existing connector
health counts remain independent.

The low-level vehicle chargeTimeMin zero-power/degenerate-input contract is
unchanged. Provider metadata is checked before it enters stop timing. Plans
that cannot produce finite time estimates fail without a route verdict.
AI alternatives reuse the same candidates, finalization, totals, warnings and
scan-integrity status. Every candidate is still fetched; there is no lookup
pruning, provider call reduction or new endpoint.

Validation is offline with raw-detail mutations and synthetic browser data.
It does not establish a current provider incident, physical model accuracy,
or a new successful live-route result.
