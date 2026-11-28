import type algosdk from 'algosdk'

// Session memo for indexer reads, cleared wholesale by `clearTreeCache` around proof-carrying submissions; one invalidation rule keeps the cost to one re-download per mutation.
export const appCallCache = new Map<bigint, Promise<algosdk.indexerModels.Transaction[]>>()
export const blockCache = new Map<bigint, Promise<{ transactions?: algosdk.indexerModels.Transaction[] }>>()
// Keep concurrent block reads small enough that a large replay does not trip the indexer rate limit.
export const BLOCK_LOOKUP_CHUNK = 16

/**
 * Drop memoized indexer reads; the SDK's write helpers call it around proof-carrying submissions, plain reads reuse the cache.
 */
export function clearTreeCache(): void {
  appCallCache.clear()
  blockCache.clear()
}

/**
 * Memoized fetch so duplicate and repeat reads reuse one download; only resolved values stick, so a transient failure retries naturally.
 *
 * @param cache Memo map keyed by id.
 * @param key Cache key.
 * @param load The fetch to memoize.
 * @returns The cached or freshly loaded value.
 */
export function cached<T>(cache: Map<bigint, Promise<T>>, key: bigint, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const pending = load()
  cache.set(key, pending)
  void pending.catch(() => {
    cache.delete(key)
  })
  return pending
}
