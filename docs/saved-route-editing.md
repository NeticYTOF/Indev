# Saved route editing

Saved trips are readable records, not silently mutable plans. Both the saved
trips drawer and an opened saved-trip summary provide **Edit route**. The
action copies the saved origin label and exact coordinates, destination label
and exact coordinates, and stored vehicle facts into the normal planner
composer for manual review. It does not call geocoding, planning, AI, station
revalidation, or save APIs. The saved trip is not changed.

A visible review notice separates copied facts from settings that were never
stored:

- start charge, reserve, and other planner options are explicitly marked as
  not saved and must be reviewed; the current charge stepper keeps its
  existing value rather than inventing a recovered saved value;
- a stored catalog ID is used only when it still exists in the catalog and
  the stored battery matches it; the stored real-world range remains a user
  input and manufacturer claims never replace it;
- unknown, stale, default, or unavailable catalog metadata falls back to the
  ordinary custom-vehicle form with the original saved label named in a
  visible review note. An unknown battery stays blank; no default or claim is
  substituted unnoticed.

The origin/destination setters use saved coordinates directly and invalidate
pending autocomplete sessions, so a late geocoder response cannot replace the
saved pair. Subsequent typing follows the normal "pick a suggestion before
planning" invalidation rule. If the vehicle catalog is still loading, standard
and AI submit are refused until the saved vehicle selection has settled or
has been explicitly re-edited.

Editing is refused while a plan request is in flight. A late plan response can
therefore never replace a newly loaded draft. On success, the old saved
summary is removed before the draft appears, and keyboard focus moves into the
composer. On mobile the planner sheet opens at the same time.

Planning is always a new manual action using the existing **Plan route** or
**Plan with AI** button. Saving a resulting plan is likewise the existing
explicit **save** action and creates/stores a plan through the normal save
path; nothing is written merely by editing a saved trip.

The drawer's **Return trip** action and the saved summary's **Plan return trip**
action build a separate draft with only the saved origin and destination
swapped, plus the same known vehicle facts. Saved stops, geometry, totals and
previous results are not reversed or reused, and the stored trip is unchanged.
The review heading and first note explicitly identify a new return-direction
plan that requires a manual **Plan route**; the ordinary not-stored settings
notes remain visible. Invalid endpoint coordinates are refused by the same
readiness guard as Edit.

After either guard passes, Edit and Return clear the previous map route, stop
markers and results before loading the new composer draft; a busy or invalid
draft leaves the current map and results untouched. No plan, geocode, station,
AI or save request starts from either action.
