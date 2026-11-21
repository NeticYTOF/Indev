/**
 * ONE upstream run at a time for this process. The same gate is taken by the
 * legacy sync endpoints and by long jobs: no concurrent provider work is
 * ever admitted. A lease is released only by the code that actually finishes
 * (or fully unwinds) the run - never by a cancel request that merely marks a
 * job terminal while its underlying work may still be in flight.
 */
export class SingleRunSlot {
  private busy = false;

  get occupied(): boolean {
    return this.busy;
  }

  /** Returns null when another run owns the slot; otherwise a one-shot release. */
  acquire(): (() => void) | null {
    if (this.busy) return null;
    this.busy = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy = false;
    };
  }
}
