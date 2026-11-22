/**
 * Campaign read model: maps indexer responses into a `CampaignViewModel` a UI can render. The contract is the source
 * of truth - everything here is derived from the same public state the contract reads and writes.
 *
 * A backer's pledge is reconstructed from history, not read as a balance: their live leaves in the campaign's
 * frontier-Merkle tree (see `claim-tree/`), summed. Which campaigns are official is decided by the Registry -
 * the list view only shows campaigns registered with the configured Registry app (see `chain.ts`).
 *
 * See docs/campaign.md and docs/frontend.md for the on-chain model:
 *
 * - Global state: `creator` (bytes), `title` (bytes), `metadataUri` (bytes), `goal`/`deadline`/`raised`/`status` (uint),
 *   plus the tree state `root` (bytes) and `n` (uint, positions ever appended).
 * - Backer pledges: live leaves in the tree (no boxes, no assets, no per-backer storage).
 */

export { decodeGlobalState, isCampaignApp } from './decode.js'
export { fetchCampaignHeader } from './header.js'
export {
  clearCachedCampaigns,
  enumerateCampaigns,
  fetchMyPledge,
  fetchRegisteredCampaignIds,
  getCachedCampaigns,
  getCampaign,
  isRegistered,
  listCampaigns,
  setCachedCampaigns,
} from './read.js'
export { campaignFromHeader, getCampaignStatus, toCampaignViewModel } from './view.js'
export type { CampaignHeader, CampaignStatus, CampaignViewModel } from './view.js'
