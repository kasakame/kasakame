/**
 * Campaign read model: maps indexer responses into a `CampaignViewModel`, derived from the same public state the contract reads and writes (see docs/campaign.md and docs/frontend.md).
 */

export { clearCachedCampaigns, getCachedCampaigns, setCachedCampaigns } from './cache.js'
export { decodeGlobalState, isCampaignApp } from './decode.js'
export { enumerateCampaigns, fetchRegisteredCampaignIds, isRegistered } from './discovery.js'
export { fetchCampaignHeader } from './header.js'
export { fetchMyPledge, getCampaign, listCampaigns } from './read.js'
export { campaignFromHeader, getCampaignStatus, toCampaignViewModel } from './view.js'
export type { CampaignHeader, CampaignStatus, CampaignViewModel } from './view.js'
