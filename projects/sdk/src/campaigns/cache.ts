import type { CampaignViewModel } from './view.js'

/** Last good base list (pledge-free view models), for instant paint across navigations. */
let cachedList: { campaigns: CampaignViewModel[]; nowSeconds: bigint } | undefined

/**
 * Read the cached base list, if a previous load stored one.
 *
 * @returns Cached campaigns and timestamp, or undefined on first load.
 */
export function getCachedCampaigns(): { campaigns: CampaignViewModel[]; nowSeconds: bigint } | undefined {
  return cachedList
}

/**
 * Store a fresh base list for instant paint on later mounts.
 *
 * @param result Fresh campaigns and timestamp.
 * @param result.campaigns Campaign view models.
 * @param result.nowSeconds Chain timestamp.
 */
export function setCachedCampaigns(result: { campaigns: CampaignViewModel[]; nowSeconds: bigint }): void {
  cachedList = result
}

/**
 * Drop the cached base list (tests and explicit refreshes).
 */
export function clearCachedCampaigns(): void {
  cachedList = undefined
}
