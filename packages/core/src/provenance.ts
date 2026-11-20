/** Legacy replies may omit freshness flags; explicit conflicting or malformed
 * evidence must never be stamped as a fresh live result. Source labels are
 * descriptive only, not a guessed provider allowlist. */
export function hasFreshProvenance(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return (!Object.prototype.hasOwnProperty.call(evidence, 'live') || evidence.live === true) &&
    (!Object.prototype.hasOwnProperty.call(evidence, 'retained') || evidence.retained === false);
}
