import { VAULT_BOX_STATUS_FAILED_HEX, VAULT_BOX_STATUS_OPEN_HEX } from '@kasakame/constants'
import type algosdk from 'algosdk'
import { getSdkConfig } from '../chain.js'
import { fetchVaultBox } from '../transactions/vault.js'
import { campaignStatusFromRaw, decodeCreateArgs, decodeGlobalState } from './decode.js'
import type { CampaignHeader } from './view.js'

const VAULT_BOX_STATUS_OPEN = Number.parseInt(VAULT_BOX_STATUS_OPEN_HEX, 16)
const VAULT_BOX_STATUS_FAILED = Number.parseInt(VAULT_BOX_STATUS_FAILED_HEX, 16)

/**
 * Build a campaign header from an indexer application: global state for live campaigns, history for deleted ones (creation txn decoded from its round, total recovered from the vault box, status best-effort).
 *
 * @param application Indexer application, live or deleted.
 * @returns The campaign header.
 */
export async function headerFromApplication(application: algosdk.indexerModels.Application): Promise<CampaignHeader> {
  const indexer = getSdkConfig().algorand.client.indexer
  const deleted = application.deleted === true
  const rawCreator = application.params.creator
  /* v8 ignore next - the indexer always returns a creator string; the Address-object branch is defensive */
  const creator = rawCreator === undefined ? '' : typeof rawCreator === 'string' ? rawCreator : rawCreator.toString()

  let title = ''
  let metadataUri = ''
  let goalMicroAlgos = 0n
  let deadlineSeconds = 0n
  let raisedMicroAlgos = 0n
  let status: CampaignHeader['status'] = 'open'

  if (!deleted) {
    const state = decodeGlobalState(application)
    title = state.title ?? ''
    metadataUri = state.metadataUri ?? ''
    goalMicroAlgos = state.goal ?? 0n
    deadlineSeconds = state.deadline ?? 0n
    raisedMicroAlgos = state.raised ?? 0n
    status = campaignStatusFromRaw(state.status)
  } else {
    const createdAtRound = application.createdAtRound
    if (createdAtRound !== undefined) {
      const block = await indexer.lookupBlock(createdAtRound).do()
      const transactions = block.transactions ?? []
      const creation = transactions.find((tx) => tx.createdApplicationIndex !== undefined && tx.createdApplicationIndex === application.id)
      const args = creation?.applicationTransaction?.applicationArgs
      // On-chain args carry the 4-byte ARC-4 method selector first; the decode helper takes the tuple without it.
      if (args !== undefined && args.length >= 6) {
        const decoded = decodeCreateArgs(args.slice(1))
        title = decoded.title
        metadataUri = decoded.metadataUri
        goalMicroAlgos = decoded.goal
        deadlineSeconds = decoded.deadline
      }
    }
    const box = await fetchVaultBox(application.id)
    if (box !== undefined) {
      raisedMicroAlgos = box.paidIn - box.paidOut
      status = box.status === VAULT_BOX_STATUS_OPEN ? 'open' : box.status === VAULT_BOX_STATUS_FAILED ? 'failed' : 'claimed'
    }
  }

  return {
    id: application.id,
    creator,
    title,
    metadataUri,
    goalMicroAlgos,
    deadlineSeconds,
    raisedMicroAlgos,
    status,
    deleted,
  }
}

/**
 * Fetch a campaign's header: the immutable creation metadata plus its live total and raw status (deleted campaigns are recovered from history).
 *
 * @param appId Campaign application id.
 * @returns The campaign header, or undefined when the application is not indexed.
 */
export async function fetchCampaignHeader(appId: bigint): Promise<CampaignHeader | undefined> {
  const response = await getSdkConfig().algorand.client.indexer.lookupApplications(appId).includeAll(true).do()
  const application = response.application
  if (!application) return undefined
  return headerFromApplication(application)
}
