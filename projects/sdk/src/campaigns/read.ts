import type algosdk from 'algosdk'
import { fetchMyLeaves } from '../claim-tree/index.js'
import { fetchChainTimestamp } from '../runtime/clock.js'
import { getSdkConfig } from '../runtime/config.js'
import { sdkLogger } from '../runtime/log.js'
import { setCachedCampaigns } from './cache.js'
import { isCampaignApp } from './decode.js'
import { fetchRegisteredCampaignIds } from './discovery.js'
import { headerFromApplication } from './header.js'
import type { CampaignViewModel } from './view.js'
import { campaignFromHeader, toCampaignViewModel } from './view.js'

/**
 * Fetch the connected wallet's live pledge total for a campaign: the sum of their unspent leaves, rebuilt from history (see `claim-tree/`).
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
 * List all campaigns. With a Registry, look each registered id up directly and keep readable campaigns when one lookup fails; without one, scan applications (small chains only).
 *
 * @param viewerAddress Connected wallet address, if any.
 * @returns The campaigns with the chain timestamp used to derive them.
 */
export async function listCampaigns(viewerAddress?: string): Promise<{ campaigns: CampaignViewModel[]; nowSeconds: bigint }> {
  const registryId = getSdkConfig().registryAppId
  if (registryId <= 0n) {
    // No registry: fall back to scanning indexed applications for our global-state keys (no app-name filter exists); only viable on small chains (docs/frontend.md).
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
  // One bad id must not blank the list: log its lookup and keep the readable campaigns.
  const settled = await Promise.allSettled(
    [...registered].map(async (id) => {
      try {
        return await getCampaign(id, now, viewerAddress)
      } catch (error) {
        sdkLogger().warn('campaigns.list.lookup-failed', {
          appId: id.toString(),
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }),
  )
  const campaigns = settled
    .filter((result): result is PromiseFulfilledResult<CampaignViewModel | undefined> => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter((campaign): campaign is CampaignViewModel => campaign !== undefined && campaign.deleted !== true)
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
  // Deleted apps are excluded by default - include them so the detail page renders the deleted state (backers refund from the vault after deletion).
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
