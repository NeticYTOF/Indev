# Charging-station evidence workspace

Both a fresh plan and an opened saved trip render one reusable, expandable
station-evidence workspace per charging stop. It separates:

- **Planned snapshot from the trip** — the tariff, added energy, charge time,
  and state of charge that the plan used, plus the planned charger/plug data
  available in the returned plan. A saved trip keeps only the planned charging
  facts; the old plan is never rewritten by a newer station lookup.
- **Manual station status** — details received only after the user explicitly
  presses **Revalidate** (fresh plan) or **Fetch current details** (saved
  trip). Expanding the native `<details>` element alone starts no request.

The workspace normalizes the endpoint's `{ station }` body through one typed
boundary. It renders every returned charger and connector, power, known
precise tariff, raw status, derived health, contradiction/invalid-availability
flags, CCS2 availability counts, last-used values, and fetch time. Reliability
remains explicitly unavailable: no verified score is supplied. Missing or
malformed values appear as `Unknown`—never as zero, available, healthy, or a
made-up timestamp. A missing charger list is reported separately from an
empty list.

## Provenance

The current HTTP station endpoint returns a fetch timestamp but no `live`
flag. A successful manual call with a valid fetch time is therefore described
as **station details received**: charger availability is a snapshot and is not
guaranteed live. A response explicitly marked `retained: true` or `live: false`
is labelled retained/non-live; an invalid or absent timestamp leaves the
snapshot time `Unknown` and says availability is unverified.
Stations marked synthetic by mock mode keep a prominent synthetic banner.

Raw fetched connectors are classified from their status, availability, and
note using the core plug rules. A `health` label on a raw connector is not
trusted over that evidence. The mock endpoint's derived `plugs` shape, which
has no raw status, retains its supplied health label only for that shape.

## Manual fetch safety

One explicit click performs exactly one call to the existing
`GET /api/stations/:id` endpoint. There is no refresh-all control, no automatic
fetch on panel expansion or saved-trip open, and no retry loop. A pending call
disables its own button and blocks duplicate dispatches. Responses with a
different station ID, stale generation, or a detached view are discarded
instead of being written into another stop. After either outcome the same
button becomes available for another explicit attempt; keyboard focus is
restored only if the button's previous focus was lost to the body.

The shared controller uses the existing endpoint and does not modify providers,
planner policy, candidate lookup, pacing, saved records, or the deployed
worker. External station links pass the existing URL allowlist; all upstream
text is escaped before rendering.
