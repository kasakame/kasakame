import {
  MAX_CAMPAIGN_DURATION_SECONDS,
  MAX_GOAL_MICRO_ALGOS,
  MAX_METADATA_URI_BYTES,
  MAX_TITLE_BYTES,
  MIN_CAMPAIGN_DURATION_SECONDS,
  MIN_GOAL_MICRO_ALGOS,
} from '@kasakame/constants'
import { CampaignFactory } from '../generated/CampaignClient.js'
import { fetchChainTimestamp } from '../runtime/clock.js'
import { getSdkConfig } from '../runtime/config.js'
import { waitForIndexerCatchUpBestEffort } from '../runtime/indexer.js'
import { sdkLogger } from '../runtime/log.js'
import type { WalletSession } from './clients.js'
import type { WriteConfirmation } from './confirmation.js'
import { writeConfirmation } from './confirmation.js'
import {
  classifyChainError,
  classifySubmission,
  isAlreadyRegisteredError,
  logSdkFailure,
  logWriteConfirmed,
  submitWithClassification,
  validationError,
} from './errors.js'
import { sendRegister } from './register.js'
import { verifyDeployment } from './verify.js'

/** Result of `createCampaign`: the campaign exists, and `registered` is false when the Registry step failed. */
export interface CreateCampaignResult extends WriteConfirmation {
  appId: bigint
  appAddress: string
  /** True when registration landed, or when no Registry is configured. */
  registered: boolean
  /** The Registry failure message when `registered` is false. */
  registerError?: string
  /** Base32 transaction ids for the registration group, when it landed. */
  registerTxIds?: string[]
}

/**
 * Deploy a new campaign: create, then register with the Registry; nothing is funded. When registration fails the campaign still exists with `registered: false`, and `registerCampaign` retries it.
 *
 * @param session Wallet session holding the signer and address.
 * @param title Short campaign title (stored on-chain).
 * @param metadataUri URI of the off-chain campaign metadata.
 * @param goalMicroAlgos Funding target in microAlgos.
 * @param deadlineSeconds Deadline as a UNIX timestamp (seconds).
 * @returns The new app id, escrow address, and whether registration completed.
 */
export async function createCampaign(
  session: WalletSession,
  title: string,
  metadataUri: string,
  goalMicroAlgos: bigint,
  deadlineSeconds: bigint,
): Promise<CreateCampaignResult> {
  const { algorand, registryAppId, vaultAppId } = getSdkConfig()
  const titleBytes = new TextEncoder().encode(title)
  if (titleBytes.length === 0) validationError('title is required', 'createCampaign')
  if (titleBytes.length > MAX_TITLE_BYTES) {
    validationError(`title must be at most ${String(MAX_TITLE_BYTES)} bytes`, 'createCampaign')
  }
  const metadataUriBytes = new TextEncoder().encode(metadataUri)
  if (metadataUriBytes.length > MAX_METADATA_URI_BYTES) {
    validationError(`metadata URI must be at most ${String(MAX_METADATA_URI_BYTES)} bytes`, 'createCampaign')
  }
  if (goalMicroAlgos < MIN_GOAL_MICRO_ALGOS || goalMicroAlgos > MAX_GOAL_MICRO_ALGOS) {
    validationError(`goal must be between ${String(MIN_GOAL_MICRO_ALGOS)} and ${String(MAX_GOAL_MICRO_ALGOS)} microAlgos`, 'createCampaign')
  }
  const now = await fetchChainTimestamp()
  const earliestDeadline = now + BigInt(MIN_CAMPAIGN_DURATION_SECONDS)
  const latestDeadline = now + BigInt(MAX_CAMPAIGN_DURATION_SECONDS)
  if (deadlineSeconds < earliestDeadline || deadlineSeconds > latestDeadline) {
    validationError(
      `deadline must be between ${String(earliestDeadline)} and ${String(latestDeadline)} (chain time ${String(now)})`,
      'createCampaign',
    )
  }
  await verifyDeployment()
  const campaignFactory = new CampaignFactory({
    algorand,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })

  const sendResult = await submitWithClassification('createCampaign', () =>
    campaignFactory.send.create.create({
      args: {
        vault: vaultAppId,
        title: titleBytes,
        metadataUri: metadataUriBytes,
        goal: goalMicroAlgos,
        deadline: deadlineSeconds,
      },
      appReferences: [vaultAppId],
    }),
  )

  const appId = sendResult.result.appId
  const appAddress = sendResult.result.appAddress.toString()
  const confirmation = writeConfirmation(sendResult.result)

  // Register with the Registry (when configured) so the browse page treats the campaign as official; first-touch credit verifies registration on-chain.
  let registered = true
  let registerError: string | undefined
  let registerTxIds: string[] | undefined
  if (registryAppId > 0n) {
    try {
      const registerResult = await classifySubmission('registerCampaign', () => sendRegister(appId, session), appId)
      registerTxIds = registerResult.txIds
    } catch (error) {
      const classified = classifyChainError(error, { operation: 'registerCampaign', appId })
      if (isAlreadyRegisteredError(classified)) {
        sdkLogger().debug('register.already-registered', { appId: appId.toString() })
      } else {
        logSdkFailure(classified)
        registered = false
        registerError = classified.message
      }
    }
  }

  // Best-effort: both writes are confirmed; the next read retries if the indexer is briefly behind.
  await waitForIndexerCatchUpBestEffort()
  logWriteConfirmed('createCampaign', appId, confirmation)

  return {
    ...confirmation,
    appId,
    appAddress,
    registered,
    ...(registerError === undefined ? {} : { registerError }),
    ...(registerTxIds === undefined ? {} : { registerTxIds }),
  }
}
