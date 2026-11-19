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
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
