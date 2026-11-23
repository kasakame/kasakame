import { microAlgos } from '@algorandfoundation/algokit-utils'
import {
  APP_ID_BYTES,
  MAX_CAMPAIGN_DURATION_SECONDS,
  MAX_GOAL_MICRO_ALGOS,
  MAX_METADATA_URI_BYTES,
  MAX_TITLE_BYTES,
  MIN_CAMPAIGN_DURATION_SECONDS,
  MIN_GOAL_MICRO_ALGOS,
  REGISTER_DEPOSIT_MICRO_ALGOS,
  REGISTRY_BOX_PREFIX,
} from '@kasakame/constants'
import { fetchChainTimestamp, getSdkConfig, waitForIndexerCatchUp } from '../chain.js'
import { CampaignFactory } from '../generated/CampaignClient.js'
import type { WalletSession } from './clients.js'
import { registryClientFor } from './clients.js'

/** Result of `createCampaign`: the campaign exists, and `registered` is false when the Registry step failed. */
export interface CreateCampaignResult {
  appId: bigint
  appAddress: string
  /** True when registration landed, or when no Registry is configured. */
  registered: boolean
  /** The Registry failure message when `registered` is false. */
  registerError?: string
}

/**
 * The Registry's registration box for a campaign (prefix 'r' + 8-byte big-endian app id) - the inner `isRegistered`
 * check needs it.
 *
 * @param appId The campaign application id.
 * @returns Box references for the Registry app.
 */
export function registrationBox(appId: bigint): { appId: bigint; name: Uint8Array }[] {
  let remaining = appId
  const appIdBytes = new Uint8Array(APP_ID_BYTES)
  for (let i = APP_ID_BYTES - 1; i >= 0; i--) {
    appIdBytes[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return [{ appId: getSdkConfig().registryAppId, name: new Uint8Array([REGISTRY_BOX_PREFIX.charCodeAt(0), ...appIdBytes]) }]
}

/**
 * Send the Registry registration group for a campaign. The caller must be the campaign creator; the group is the
 * registration app call and its refundable deposit payment.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the creator's signer and address.
 */
async function sendRegister(appId: bigint, session: WalletSession): Promise<void> {
  const { algorand } = getSdkConfig()
  const registryClient = registryClientFor(session)
  await registryClient.send.register({
    args: {
      app: appId,
      payment: await algorand.createTransaction.payment({
        sender: session.address,
        receiver: registryClient.appAddress,
        amount: microAlgos(REGISTER_DEPOSIT_MICRO_ALGOS),
      }),
    },
    appReferences: [appId],
  })
}

/**
 * Register an existing campaign with the Registry after a failed create-time registration. Safe to retry: a campaign
 * that is already registered is treated as success. A no-op when no Registry is configured.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the creator's signer and address.
 */
export async function registerCampaign(appId: bigint, session: WalletSession): Promise<void> {
  if (getSdkConfig().registryAppId === 0n) return
  try {
    await sendRegister(appId, session)
  } catch (error) {
    // A retry can race a registration that landed but whose confirmation was lost; the Registry message is stable.
    if (!(error instanceof Error) || !/campaign already registered/i.test(error.message)) throw error
  }
  await waitForIndexerCatchUp()
}

/**
 * Deploy a new campaign: create, then register with the Registry. Nothing is funded - the v2 escrow never holds funds.
 * Registration is a separate step because it references the app id from the creation round. When it fails, the
 * campaign still exists and the result carries its id with `registered: false`; `registerCampaign` retries without
 * recreating it.
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
  if (titleBytes.length === 0) throw new Error('title is required')
  if (titleBytes.length > MAX_TITLE_BYTES) {
    throw new Error(`title must be at most ${String(MAX_TITLE_BYTES)} bytes`)
  }
  const metadataUriBytes = new TextEncoder().encode(metadataUri)
  if (metadataUriBytes.length > MAX_METADATA_URI_BYTES) {
    throw new Error(`metadata URI must be at most ${String(MAX_METADATA_URI_BYTES)} bytes`)
  }
  if (goalMicroAlgos < MIN_GOAL_MICRO_ALGOS || goalMicroAlgos > MAX_GOAL_MICRO_ALGOS) {
    throw new Error(`goal must be between ${String(MIN_GOAL_MICRO_ALGOS)} and ${String(MAX_GOAL_MICRO_ALGOS)} microAlgos`)
  }
  const now = await fetchChainTimestamp()
  const earliestDeadline = now + BigInt(MIN_CAMPAIGN_DURATION_SECONDS)
  const latestDeadline = now + BigInt(MAX_CAMPAIGN_DURATION_SECONDS)
  if (deadlineSeconds < earliestDeadline || deadlineSeconds > latestDeadline) {
    throw new Error(`deadline must be between ${String(earliestDeadline)} and ${String(latestDeadline)} (chain time ${String(now)})`)
  }
  const campaignFactory = new CampaignFactory({
    algorand,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })

  const sendResult = await campaignFactory.send.create.create({
    args: {
      vault: vaultAppId,
      title: titleBytes,
      metadataUri: metadataUriBytes,
      goal: goalMicroAlgos,
      deadline: deadlineSeconds,
    },
    appReferences: [vaultAppId],
  })

  const appId = sendResult.result.appId
  const appAddress = sendResult.result.appAddress.toString()

  // Register with the Registry (when configured) so the browse page treats the campaign as official. First-touch
  // credit verifies registration on-chain, so an unregistered campaign can never take pledges.
  let registered = true
  let registerError: string | undefined
  if (registryAppId > 0n) {
    try {
      await sendRegister(appId, session)
    } catch (error) {
      registered = false
      registerError = error instanceof Error ? error.message : String(error)
    }
  }

  // The generated create result doesn't expose the confirmation round, so wait for the indexer to catch up to algod's current tip.
  await waitForIndexerCatchUp()

  return { appId, appAddress, registered, ...(registerError === undefined ? {} : { registerError }) }
}
