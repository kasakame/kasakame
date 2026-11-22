import type { BackerLeaf, CampaignHeader } from '../../src/index.js'
import { fetchCampaignHeader } from '../../src/index.js'

/**
 * Fetch a campaign header, throwing when the indexer has not caught up.
 *
 * @param appId Campaign application id.
 * @returns The campaign header.
 */
export async function headerOf(appId: bigint): Promise<CampaignHeader> {
  const header = await fetchCampaignHeader(appId)
  if (header === undefined) throw new Error(`campaign ${appId.toString()} was not indexed`)
  return header
}

/**
 * Find a leaf by position, throwing when it is missing.
 *
 * @param leaves The viewer's leaves.
 * @param position Leaf position.
 * @returns The matching leaf.
 */
export function leafAt(leaves: BackerLeaf[], position: number): BackerLeaf {
  const leaf = leaves.find((candidate) => candidate.position === position)
  if (leaf === undefined) throw new Error(`leaf ${position.toString()} missing`)
  return leaf
}
