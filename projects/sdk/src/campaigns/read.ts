import { REGISTRY_BOX_PREFIX, VAULT_BOX_PREFIX } from '@kasakame/constants'
import type algosdk from 'algosdk'
import { fetchChainTimestamp, getSdkConfig } from '../chain.js'
import { fetchMyLeaves } from '../claim-tree/index.js'
import { RegistryClient } from '../generated/RegistryClient.js'
import { decodeBoxAppId, isCampaignApp } from './decode.js'
import { headerFromApplication } from './header.js'
import type { CampaignViewModel } from './view.js'
import { campaignFromHeader, toCampaignViewModel } from './view.js'

// Box name prefixes: a single byte plus an 8-byte big-endian campaign app id.
const REGISTRATION_BOX_PREFIX_BYTE = REGISTRY_BOX_PREFIX.charCodeAt(0)
const VAULT_BOX_PREFIX_BYTE = VAULT_BOX_PREFIX.charCodeAt(0)

/**
 * Fetch the connected wallet's live pledge total for a campaign: the sum of their unspent leaves. Rebuilt from
 * history (see `claim-tree/`) - there is no balance to read.
 *
 * @param appId Campaign application id.
 * @param address Viewer's Algorand address.
 * @returns Pledge in microAlgos, or undefined if the backer has no live leaves.
 */
export async function fetchMyPledge(appId: bigint, address: string): Promise<bigint | undefined> {
  const leaves = await fetchMyLeaves(appId, address)
  if (leaves.length === 0) return undefined
  return leaves.reduce((sum, leaf) => sum + leaf.amount, 0n)
}

/**
 * Fetch every app id registered with the Registry (paginated box search), decoded from the registration box names.
 *
 * @param registryId The Registry application id.
 * @returns The set of registered campaign app ids.
 */
export async function fetchRegisteredCampaignIds(registryId: bigint): Promise<Set<bigint>> {
  const indexer = getSdkConfig().algorand.client.indexer
  const registered = new Set<bigint>()
  let nextToken: string | undefined
  do {
    let query = indexer.searchForApplicationBoxes(registryId).limit(1000)
    if (nextToken !== undefined) query = query.nextToken(nextToken)
    const response = await query.do()
    for (const box of response.boxes) {
      // Box name: 'r' (1 byte) + the campaign app id (8 bytes, big-endian).
      const id = decodeBoxAppId(box.name, REGISTRATION_BOX_PREFIX_BYTE)
      if (id !== undefined) registered.add(id)
    }
    nextToken = response.nextToken
  } while (nextToken !== undefined)
  return registered
}

/**
 * Whether a campaign is registered with the configured Registry - the check `ClaimsVault.credit` runs on a campaign's
 * first pledge. Gate pledge actions on it so an unregistered app never produces a doomed transaction.
 *
 * @param appId Campaign application id.
 * @returns True when the Registry's registration box exists for the app; false when it does not, or when no Registry is
 *   configured (nothing can be registered then).
 */
export async function isRegistered(appId: bigint): Promise<boolean> {
  const { algorand, registryAppId } = getSdkConfig()
  if (registryAppId <= 0n) return false
  const registryClient = new RegistryClient({ algorand, appId: registryAppId })
  try {
    return (await registryClient.state.box.registered.value(appId)) !== undefined
  } catch (error) {
    // A deleted campaign has no registration box; algod reports that as 404 rather than an empty value.
    if (error instanceof Error && /box not found/i.test(error.message)) return false
    throw error
  }
}

/**
 * Fetch every campaign that has a vault box (the box lives until the campaign settles and its box is released by
 * `notifyDelete` or `finalize`), so deleted-but-unfinalized campaigns surface too.
 *
 * @param vaultId The ClaimsVault application id.
 * @returns Campaign app ids with a vault box.
 */
async function fetchVaultCampaignIds(vaultId: bigint): Promise<Set<bigint>> {
  const indexer = getSdkConfig().algorand.client.indexer
  const vaulted = new Set<bigint>()
  let nextToken: string | undefined
  do {
    let query = indexer.searchForApplicationBoxes(vaultId).limit(1000)
    if (nextToken !== undefined) query = query.nextToken(nextToken)
    const response = await query.do()
    for (const box of response.boxes) {
      // Box name: 'c' (1 byte) + the campaign app id (8 bytes, big-endian).
      const id = decodeBoxAppId(box.name, VAULT_BOX_PREFIX_BYTE)
      if (id !== undefined) vaulted.add(id)
    }
    nextToken = response.nextToken
  } while (nextToken !== undefined)
  return vaulted
}

/**
 * Enumerate every campaign app id worth browsing: every campaign registered with the Registry plus every campaign
 * that has a vault box (campaigns that received at least one pledge, including deleted-but-unfinalized ones whose
 * vault box hasn't been released yet). The union dedupes - a registered campaign with pledges appears once.
 *
 * @returns The campaign app ids.
 */
export async function enumerateCampaigns(): Promise<Set<bigint>> {
  const { registryAppId, vaultAppId } = getSdkConfig()
  const registered = registryAppId > 0n ? await fetchRegisteredCampaignIds(registryAppId) : new Set<bigint>()
  const vaulted = await fetchVaultCampaignIds(vaultAppId)
  for (const id of vaulted) registered.add(id)
  return registered
}

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

/**
 * List all campaigns. With a Registry configured, look each registered id up directly - the unfiltered application
 * scan below works on sandbox-sized chains but never finishes on TestNet-scale chains (tens of thousands of apps,
 * each response carrying full approval programs).
 *
 * @param viewerAddress Connected wallet address, if any.
 * @returns The campaigns with the chain timestamp used to derive them.
 */
export async function listCampaigns(viewerAddress?: string): Promise<{ campaigns: CampaignViewModel[]; nowSeconds: bigint }> {
  const registryId = getSdkConfig().registryAppId
  if (registryId <= 0n) {
    // No registry: fall back to scanning indexed applications for our global-state keys. There is no app-name filter
    // on the indexer, so presence of the known keys is the discriminator (docs/frontend.md). Only viable on small
    // chains.
    const indexer = getSdkConfig().algorand.client.indexer
    const now = await fetchChainTimestamp()
    const applications: algosdk.indexerModels.Application[] = []
    let nextToken: string | undefined
    do {
      let query = indexer.searchForApplications().limit(100)
      if (nextToken !== undefined) query = query.nextToken(nextToken)
      const response = await query.do()
      applications.push(...response.applications)
      nextToken = response.nextToken
    } while (nextToken !== undefined)

    const campaigns: CampaignViewModel[] = []
    for (const app of applications) {
      if (!isCampaignApp(app)) continue
      let myPledge: bigint | undefined
      if (viewerAddress) {
        myPledge = await fetchMyPledge(app.id, viewerAddress)
      }
      campaigns.push(toCampaignViewModel(app, now, myPledge))
    }
    const result = { campaigns, nowSeconds: now }
    setCachedCampaigns(result)
    return result
  }

  // Timestamp and registry are independent: fetch together so first paint waits on one round-trip, not two.
  const [now, registered] = await Promise.all([fetchChainTimestamp(), fetchRegisteredCampaignIds(registryId)])
  const settled = await Promise.all([...registered].map((id) => getCampaign(id, now, viewerAddress)))
  const campaigns = settled.filter((campaign): campaign is CampaignViewModel => campaign !== undefined && campaign.deleted !== true)
  const result = { campaigns, nowSeconds: now }
  setCachedCampaigns(result)
  return result
}

/**
 * Fetch a single campaign by app id.
 *
 * @param appId Campaign application id.
 * @param nowSeconds Current UNIX timestamp (seconds).
 * @param viewerAddress Connected wallet address, if any.
 * @returns The campaign, or undefined if not found or not a campaign app.
 */
export async function getCampaign(appId: bigint, nowSeconds: bigint, viewerAddress?: string): Promise<CampaignViewModel | undefined> {
  // Deleted apps are excluded by default - include them so the detail page can render the deleted state
  // (backers refund from the vault after deletion).
  const response = await getSdkConfig().algorand.client.indexer.lookupApplications(appId).includeAll(true).do()
  const app = response.application
  if (!app) return undefined
  if (app.deleted === true) {
    // Global state is gone: recover from history so this agrees with what the deleted section of the list renders.
    return campaignFromHeader(await headerFromApplication(app), nowSeconds)
  }
  if (!isCampaignApp(app)) return undefined

  let myPledge: bigint | undefined
  if (viewerAddress) {
    myPledge = await fetchMyPledge(app.id, viewerAddress)
  }
  return toCampaignViewModel(app, nowSeconds, myPledge)
}
