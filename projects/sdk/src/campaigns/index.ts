/**
 * Campaign read model: maps indexer responses into a `CampaignViewModel`, derived from the same public state the contract reads and writes (see docs/campaign.md and docs/frontend.md).
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
