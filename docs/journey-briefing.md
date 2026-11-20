# Journey briefing

The plan panel includes a Journey briefing after a route succeeds. It turns
facts already present in the returned `TripPlan` into a whole-trip overview:

- **Whole-trip legs**: origin → each selected station → destination. Per-stop
  `legKm` is authoritative and already includes detour travel. The final leg is
  derived from the same `totals.distanceKm` chainage used by the planner's
  reachability math plus the last stop's one-way `detourKm`; provider
  `routeDistanceKm` metadata is not substituted for that final leg.
- **Battery profile**: planned arrival/departure SoC at each stop and the
  planned destination arrival SoC from `totals.finalSocPct`. These are the
  planner's simulated values, never measured live battery readings. Starting
  charge is not stored in a returned plan, so the origin shows it as unknown.
  Accessible meters report each known 0–100% value with its stop name; absent
  or out-of-range values stay visibly and semantically unknown.
- **Print-ready itinerary**: a keyboard-scrollable table with each stop's
  arrival/departure SoC, added kWh, charge time, known cost, relative arrival
  and departure offsets, and tariff. The summary repeats route distance, total
  and charging time, energy added, known cost, and destination charge.
- **Actions**: “Journey itinerary (HTML)” downloads a standalone, saveable
  copy with flat black/orange styling and its own print stylesheet.
  “Print itinerary” opens the page print view, where map and planner controls
  are suppressed in favor of the briefing. The existing save, animated export,
  maps link, and stop cards remain unchanged. The Maps link keeps the charging
  stops in plan order; if a plan exceeds the conservative one-link bounds, the
  UI shows clearly labelled ordered segments instead of silently dropping a
  waypoint. Live Maps acceptance is verified separately from these local checks.

Times in the briefing are always relative to departure. The planner does not
return a wall-clock departure time, physical charger availability, or a
guaranteed future tariff, and the briefing never invents one. Every declared
charging stop keeps its itinerary row, even when a fact is missing or invalid:
negative energy/time/distance and SoC outside 0–100% become `Unknown` cells
with a warning, never zeros or invented values. Unknown tariffs and costs stay
`Unknown`; known fractional tariffs use the existing two-decimal formatter.
User-supplied real-world range remains a planning input only; the briefing
does not restate it as a physical guarantee.

Synthetic/degraded status, plan warnings, and briefing evidence warnings are
carried into the on-screen briefing, the standalone HTML file, and print. A
synthetic plan is labelled as mock data and never presented as live charger
evidence. Reopening a saved trip shows the same briefing from its stored
planned charging facts; because saved trips do not store per-stop ETA offsets,
those cells appear as `Unknown` rather than being recomputed with invented
timing. Station cards still fetch current details only on request.

The briefing performs no provider calls, adds no persistence, and changes no
planner, vehicle, tariff, availability, candidate-lookup, or pacing policy.

Browser source coverage exercises desktop 1280x800 and mobile 390x844, the
screen/print media views, and the downloaded HTML file. Actual rendered
pixels, print output, and PDF behavior are verified separately on Linux; the
synthetic checks are not live-provider or physical-vehicle acceptance.
