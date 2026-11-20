# Saved trip comparison

The saved-trips drawer lets the user explicitly select two stored trips with
**Select to compare** (toggled to **Remove from comparison**) and then press
**Compare selected (2/2)**. Selection is local to the open drawer, is limited to
two trips, and announces its count in a polite live status. No comparison is
created from a partial selection.

The comparison workspace is a read-only view of the same `GET /api/trips` data
already loaded by the drawer. Selecting, swapping, removing, clearing, going
back, and opening the standalone download perform no plan, geocode, station,
AI, or storage request. Opening or editing a route from the workspace calls the
existing saved-trip handlers only after an explicit button press; it creates no
new saved record. Each column has **Open route** and **Edit route** actions, and
the workspace also offers **Back to saved trips**, **Swap A and B**,
**Clear selection**, remove for either column, **Download comparison**, and
**Print comparison**.

Each side shows the stored endpoints, provenance and coverage labels, exact
stored battery/claimed range/real-world range values, planned totals, and the
ordered charging-stop itinerary with planned tariff, added kWh, SoC, leg
distance and charge time. `0` remains a known value; absent, malformed or
out-of-range facts are rendered as `Unknown`. Missing versus empty stop lists
are distinct, and malformed stop entries remain counted as `Unknown` rows. The
workspace shows planned facts only and never presents fetched charger status,
availability or live pricing; the separate station-evidence workspace owns that
boundary.

The central differences table labels every signed value as **B − A**. A
difference is emitted only when both trips store a valid value in the same unit;
otherwise the cell says `Not comparable`. Known fractional vehicle values are
not rounded or replaced by catalog defaults. Differences are arithmetic
presentations, never a best-route claim, saving claim, or win/loss ranking.
Different stored endpoints, coordinates, or vehicle fields are surfaced as
explicit context notes.

The screen layout stacks columns by default and uses three columns on wide
desktops. It uses the existing flat black/charcoal and burnt-orange design
system with no gradients. The download is a standalone HTML file with its own
print stylesheet; the in-app print view is opt-in via the comparison body class
and does not change journey-itinerary printing. Keyboard focus moves into the
workspace on entry, returns to a usable drawer control after back/remove/clear,
and stays on the swap control after a swap redraw. Escape returns from the
workspace to the saved-trips drawer without triggering the planner's separate
Escape action; the selected pair remains ready to reopen. The visible context
states that the figures are stored planned facts, lists km/minutes/kWh/INR/%
units, and repeats that no best route is inferred.
