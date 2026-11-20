# Saved trip comparison

The saved-trips drawer lets the user explicitly select two stored trips with
**Select to compare** (toggled to **Remove from comparison**) and then press
**Compare selected (2/2)**. Selection is local to the open drawer, is limited to
two trips, and announces its count in a polite live status. No comparison is
created from a partial selection.

The same drawer has a local **Search saved trips** field and Newest first /
Oldest first / Name A–Z sorting. Search matches literal text in each saved name,
origin and destination; it sends no geocoding, plan, station, AI or trip request.
Unknown or malformed created dates sort last in either date direction. A live
result count distinguishes matches, no matches, no saved trips, an unavailable
list and a failed load; **Clear search** restores the unfiltered view. Filtering
and sorting change only the local presentation: the original load index remains
attached to every row, so Compare, Open, Edit and Delete keep targeting the
record the user selected. Selected trips hidden by the search remain in the
comparison and are announced; clearing or removing the selection updates that
notice without rewriting any saved record.

Two additional local selects filter the same drawer by **Saved source** (All,
Live, Synthetic, Unknown) and **Saved plan status** (All, OK, Degraded,
Unknown). These are stored plan provenance and planning-time integrity labels,
not current charger freshness or availability. Only the exact core values are
accepted; missing, null or malformed fields appear only under Unknown. The
filters combine with search and sort, keep the original record index on every
row, and can be reset with **Clear all filters**; **Clear search** continues to
reset only the text query. Unknown source/status rows are labelled in the list.

The query, filters and sort are held only in this page's in-memory drawer state. Closing
and reopening the drawer, or a successful delete refresh, keeps the same view,
including a no-match result when the last visible record was deleted; a page
reload returns to the unfiltered newest-first view. Rebuilding the drawer clears
the comparison selection instead of restoring an index that may belong to a
deleted record, while pending, unavailable and failed loads continue to disable
the controls and show their own status rather than an empty list.

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
