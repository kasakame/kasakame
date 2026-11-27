import type algosdk from 'algosdk'
import { campaignStatusFromRaw, decodeGlobalState } from './decode.js'

export type CampaignStatus = 'open' | 'successful' | 'failed'

export interface CampaignViewModel {
  /** Application id - the campaign's unique identifier. */
  id: bigint
  /** Campaign creator address. */
  creator: string
  /** Short campaign title, stored on-chain. */
  title: string
  /** URI pointing to the off-chain campaign metadata (description, image, category). */
  metadataUri: string
  /** Funding target, in microAlgos. */
  goalMicroAlgos: bigint
  /** Total live pledge amount, in microAlgos. */
  raisedMicroAlgos: bigint
  /** Deadline as a UNIX timestamp (seconds). */
  deadlineSeconds: bigint
  /** Derived display status. `funded` is computed, never stored on-chain. */
  status: CampaignStatus
  /** True once the creator claimed (raw Claimed status); `status` is 'successful' for both claimable and claimed campaigns. */
  claimed: boolean
  /** The connected wallet's live pledge total (microAlgos), or undefined if it has no live leaves. */
  myPledgeMicroAlgos?: bigint | undefined
  /** True when the application was deleted on-chain (global state is gone; only history remains). */
  deleted?: boolean
}

/** A campaign's immutable creation metadata plus its live total and raw status. */
export interface CampaignHeader {
  /** Application id - the campaign's unique identifier. */
  id: bigint
  /** Campaign creator address. */
  creator: string
  /** Short campaign title, stored on-chain. */
  title: string
  /** URI pointing to the off-chain campaign metadata (description, image, category). */
  metadataUri: string
  /** Funding target, in microAlgos. */
  goalMicroAlgos: bigint
  /** Deadline as a UNIX timestamp (seconds). */
  deadlineSeconds: bigint
  /** Live pledge total; from globals for live campaigns, vault `paidIn - paidOut` once deleted. */
  raisedMicroAlgos: bigint
  /** Raw on-chain status byte (open/failed/claimed), kept for completeness. */
  status: 'open' | 'failed' | 'claimed'
  /** True when the application was deleted on-chain (global state is gone; fields recovered from history). */
  deleted: boolean
}

/**
 * Derive the three-value display word from a campaign header; raw `status`/`deleted` stay on the header for consumers that need them.
 *
 * @param header Campaign header from `fetchCampaignHeader`.
 * @param nowSeconds Current UNIX timestamp (seconds).
 * @returns The derived display status.
 */
export function getCampaignStatus(header: CampaignHeader, nowSeconds: bigint): 'open' | 'successful' | 'failed' {
  if (header.status === 'claimed') return 'successful'
  if (header.deadlineSeconds <= nowSeconds) {
    return header.raisedMicroAlgos >= header.goalMicroAlgos ? 'successful' : 'failed'
  }
  return 'open'
}

/**
 * Map a campaign header to a view model, deriving the display status; deleted campaigns take this path too, so every consumer renders the same recovered fields.
 *
 * @param header Campaign header, live or recovered from history.
 * @param nowSeconds Current UNIX timestamp (seconds).
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
    claimed: header.status === 'claimed',
    deleted: header.deleted,
  }
}

/**
 * Map an indexer `Application` to a `CampaignViewModel`.
 *
 * @param app Indexer application to map.
 * @param nowSeconds Current UNIX timestamp (seconds).
 * @param myPledgeMicroAlgos Viewer's pledge, if already fetched.
 * @returns The campaign view model.
 */
export function toCampaignViewModel(
  app: algosdk.indexerModels.Application,
  nowSeconds: bigint,
  myPledgeMicroAlgos?: bigint,
): CampaignViewModel {
  const state = decodeGlobalState(app)
  const goal = state.goal ?? 0n
  const raised = state.raised ?? 0n
  const deadline = state.deadline ?? 0n
  const chainStatus = campaignStatusFromRaw(state.status)

  const viewModel: CampaignViewModel = {
    id: app.id,
    creator: state.creator ?? '',
    title: state.title ?? '',
    metadataUri: state.metadataUri ?? '',
    goalMicroAlgos: goal,
    raisedMicroAlgos: raised,
    deadlineSeconds: deadline,
    status: getCampaignStatus(
      {
        id: app.id,
        creator: state.creator ?? '',
        title: state.title ?? '',
        metadataUri: state.metadataUri ?? '',
        goalMicroAlgos: goal,
        deadlineSeconds: deadline,
        raisedMicroAlgos: raised,
        status: chainStatus,
        deleted: app.deleted === true,
      },
      nowSeconds,
    ),
    claimed: chainStatus === 'claimed',
  }
  if (myPledgeMicroAlgos !== undefined) {
    viewModel.myPledgeMicroAlgos = myPledgeMicroAlgos
  }
  return viewModel
}
