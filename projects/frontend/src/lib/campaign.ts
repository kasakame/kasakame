/**
 * The campaign read model (registry reads, global-state decode, list/detail mapping, session caches) lives in
 * `@kasakame/sdk`, re-exported here for existing importers. The app ids are read from the Vite environment once, in
 * `lib/algorand.ts`, and handed to `configureSdk`.
 */

import type { CampaignHeader, CampaignViewModel } from '@kasakame/sdk'
import { getCampaignStatus } from '@kasakame/sdk'

export * from '@kasakame/sdk'

/**
 * Map a recovered campaign header to the UI view model. Deleted campaigns take this path: their fields come from
 * history (creation transaction + vault box) instead of live global state.
 *
 * @param header Campaign header from `fetchCampaignHeader`.
 * @param nowSeconds Chain timestamp (seconds) for the derived display status.
 * @returns The campaign view model.
 */
export function campaignFromHeader(header: CampaignHeader, nowSeconds: bigint): CampaignViewModel {
  return {
    id: header.id,
    creator: header.creator,
    title: header.title,
    metadataUri: header.metadataUri,
    goalMicroAlgos: header.goalMicroAlgos,
    raisedMicroAlgos: header.raisedMicroAlgos,
    deadlineSeconds: header.deadlineSeconds,
    status: getCampaignStatus(header, nowSeconds),
    deleted: header.deleted,
  }
}
