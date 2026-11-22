/**
 * Write path: assembles + signs transactions through the generated `CampaignClient`, `ClaimsVaultClient`, and
 * `RegistryClient`, plus a manual composer for the two-app pledge group. Each helper takes the wallet's signer/address
 * so the wallet - never the app - holds the keys.
 *
 * The claim-tree design (see docs/campaign.md):
 *
 * - **Creation** chains create → registry.register. Nothing is funded: the escrow never holds funds.
 * - **Pledges** are one atomic group `[pay, campaign.pledge, vault.credit]` (the payment immediately before the pledge,
 *   the matching credit immediately after it and last - the contracts reject other shapes, and the vault rejects a
 *   credit whose preceding transaction is not that pledge); the caller supplies the frontier (rebuilt
 *   from the indexer right before submitting) and retries once on a stale-proof rejection.
 * - **Cancels/refunds** null one leaf per call (`vault.payBack` path while the campaign box is open, `vault.refund`
 *   directly once settled) with the path rebuilt fresh and one stale retry.
 * - **Claims** are paid by the vault from per-campaign balance guards; **delete** settles in O(1) on every path.
 * - There are no assets anywhere: no opt-ins, no balances, no close-outs.
 */

export { createCampaign, registerCampaign } from './campaign.js'
export type { CreateCampaignResult } from './campaign.js'
export type { WalletSession } from './clients.js'
export { isStaleProofError } from './errors.js'
export { cancelPledge, pledge, pledgeGroup } from './pledge.js'
export { claim, deleteCampaign, refund, refundGroup } from './settle.js'
export { fetchVaultBox, fetchVaultConfig, refundWindowEndsAt, vaultAddress } from './vault.js'
export type { VaultBoxView } from './vault.js'
