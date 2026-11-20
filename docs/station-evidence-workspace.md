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
flag. The workspace records the browser's response-receipt time separately
from the upstream snapshot `fetchedAt`: a later receipt does not make an old
snapshot live. A successful call with a valid snapshot time is described as
**response received**, with charger availability explicitly called a snapshot
and not guaranteed live. A response explicitly marked `retained: true` or
`live: false` is labelled retained/non-live; an invalid or absent snapshot time
leaves that time `Unknown` and says availability is unverified. Stations marked
synthetic by mock mode keep a prominent synthetic banner.

Raw fetched connectors are classified from their status, availability, and
note using the core plug rules. Derived `health` is accepted only from an
actual planned/core `plugs` container or the mock endpoint's confirmed
synthetic `plugs` shape. A raw `connectors` container never trusts a supplied
`health` label, including one supplied without raw status. A missing connector
list is distinct from an empty list, and an aggregate CCS2 claim contradicted
by returned connector health is reported as an explicit warning rather than an
unchecked availability fact.

## Manual fetch safety

One explicit click performs exactly one call to the existing
`GET /api/stations/:id` endpoint. There is no refresh-all control, no automatic
fetch on panel expansion or saved-trip open, and no retry loop. A pending call
disables its own button and blocks duplicate dispatches. Responses with a
different station ID, stale generation, or a detached view are discarded
instead of being written into another stop. This includes reopening a saved
trip with the same or a different station ID and switching from a fresh plan to
a saved trip while a manual fetch is in flight. After either outcome the same
button becomes available for another explicit attempt; keyboard focus is
restored only if the button's previous focus was lost to the body. An input the
user focuses during the request keeps focus when the response settles.

Network aborts, HTTP failures, non-JSON replies, and malformed station bodies
all produce the same announced retryable status and install no fetched result.
The status element is a polite live region; expanding a details element with
the keyboard never fetches. Long and hostile upstream strings are escaped and
wrapped for desktop and 390px mobile layouts.

The shared controller uses the existing endpoint and does not modify providers,
planner policy, candidate lookup, pacing, saved records, or the deployed
worker. External station links pass the existing URL allowlist; all upstream
text is escaped before rendering. Manual fetch and details expansion write no
trip and trigger no background station lookup.

Printing follows the established journey-itinerary semantics: `.stops` and
therefore both planned and fetched station-evidence details are hidden,
whether the details were open or closed on screen. The Journey Briefing and
its summary remain the printable evidence view; this workspace does not add a
new print layout or claim that live charger availability is guaranteed.
