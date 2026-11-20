/** Small async utilities shared by core modules. */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Concurrency-limited map. Keeps outgoing requests polite when we walk a
 * route corridor and fetch many stations at once.
 */
export async function pMap<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (err) {
        // Stop claiming new work, but join every worker already started.
        // A rejected aggregate must not leave transports/progress callbacks
        // mutating run evidence after its caller reports completion.
        if (!failed) { failed = true; firstError = err; }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}
