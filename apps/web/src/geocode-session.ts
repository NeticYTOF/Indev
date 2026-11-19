/**
 * Epoch guard for one search field's geocode session (the origin and
 * destination fields each own one session object).
 *
 * The field's old defect was an unguarded async race: query A ("Delh")
 * and query B ("Delhi") could both be in flight; when A's response
 * resolved AFTER B's, the stale suggestions overwrote the fresh list.
 * A late response also repopulated and REOPENED the list after the user
 * had cleared the query or already picked a suggestion. The catch path
 * was unguarded too: a STALE request's error hid a NEWER query's list.
 *
 * Contract: a response may only be applied when no newer session began
 * and nothing (typing, clearing, picking) invalidated it since dispatch.
 * The guard only DISCARDS responses - it never adds API calls or
 * retries, and it never touches the input's text or the picked
 * coordinates.
 *
 * Pure module - unit-testable in a plain node env with manually
 * resolved promises.
 */
export class GeocodeSession {
  private epoch = 0;

  /** Begin the session for a freshly dispatched query; returns its token. */
  begin(): number {
    return ++this.epoch;
  }

  /** Invalidate every in-flight session: the user typed anew, cleared
   *  the query, or picked a result. Any late response for an older
   *  session must be discarded, never applied over the newer state. */
  invalidate(): void {
    this.epoch++;
  }

  /** Whether `token` is still the current session (nothing newer began
   *  and nothing invalidated it since its dispatch). */
  isCurrent(token: number): boolean {
    return token === this.epoch;
  }
}
