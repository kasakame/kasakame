/**
 * Write path: assembles and signs transactions through the generated clients plus a manual two-app pledge group; wallet keys stay in the wallet (design in docs/campaign.md).
 */

export { createCampaign, registerCampaign, verifyDeployment } from './campaign.js'
export type { CreateCampaignResult } from './campaign.js'
export type { WalletSession } from './clients.js'
export type { WriteConfirmation } from './confirmation.js'
export { SdkError, classifyChainError, isStaleProofError } from './errors.js'
export type { SdkErrorType, SdkOperation } from './errors.js'
export { cancelPledge, pledge, pledgeGroup } from './pledge.js'
export { claim, deleteCampaign, finalize, refund, refundGroup, releaseClaimed, settleOpen } from './settle.js'
export { fetchVaultBox, fetchVaultConfig, refundWindowEndsAt, vaultAddress } from './vault.js'
export type { VaultBoxView } from './vault.js'
