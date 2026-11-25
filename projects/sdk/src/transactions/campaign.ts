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
import { sha256 } from '@noble/hashes/sha2.js'
import { base64ToBytes, bytesToHex } from 'algosdk'
import { fetchChainTimestamp, getSdkConfig, waitForIndexerCatchUpBestEffort } from '../chain.js'
import { u64be } from '../claim-tree/tree.js'
import { APP_SPEC, CampaignFactory } from '../generated/CampaignClient.js'
import { RegistryClient } from '../generated/RegistryClient.js'
import { SPECS_VERSION } from '../generated/specs-version.js'
import type { WalletSession } from './clients.js'
import { registryClientFor } from './clients.js'
import type { WriteConfirmation } from './confirmation.js'
import { writeConfirmation } from './confirmation.js'
import { classifyChainError, isAlreadyRegisteredError, SdkError, submitWithClassification } from './errors.js'

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
 * The Registry's registration box for a campaign (prefix 'r' + 8-byte big-endian app id), needed by the inner `isRegistered` check.
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
 * Send the Registry registration group for a campaign - the registration app call plus its refundable deposit payment; the caller must be the campaign creator.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the creator's signer and address.
 * @returns The confirmed registration group result.
 */
async function sendRegister(
  appId: bigint,
  session: WalletSession,
): Promise<{ txIds: string[]; confirmation?: { confirmedRound?: bigint } }> {
  const { algorand } = getSdkConfig()
  const registryClient = registryClientFor(session)
  return registryClient.send.register({
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
 * Register an existing campaign with the Registry after a failed create-time registration; safe to retry, and a no-op when no Registry is configured.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the creator's signer and address.
 * @returns The confirmed registration, or empty txIds when it was already registered or no Registry is configured.
 */
export async function registerCampaign(appId: bigint, session: WalletSession): Promise<WriteConfirmation> {
  if (getSdkConfig().registryAppId === 0n) return { txIds: [] }
  let confirmation: WriteConfirmation
  try {
    confirmation = writeConfirmation(await submitWithClassification('registerCampaign', () => sendRegister(appId, session), appId))
  } catch (error) {
    // A retry can race a registration that landed but whose confirmation was lost.
    if (!isAlreadyRegisteredError(error)) throw error
    confirmation = { txIds: [] }
  }
  await waitForIndexerCatchUpBestEffort()
  return confirmation
}

/**
 * Hash the Campaign bytecode embedded in the generated spec: `sha256(itob(approval.length) ‖ approval ‖ clear)`.
 *
 * @returns The 32-byte program hash the Registry verifies at `register`.
 */
function campaignProgramHash(): Uint8Array {
  const byteCode = APP_SPEC.byteCode
  if (byteCode === undefined) {
    throw new SdkError('validation', 'Campaign spec has no byteCode; run codegen first', { operation: 'verifyDeployment' })
  }
  const approval = base64ToBytes(byteCode.approval)
  const clear = base64ToBytes(byteCode.clear)
  const preimage = new Uint8Array(8 + approval.length + clear.length)
  preimage.set(u64be(BigInt(approval.length)), 0)
  preimage.set(approval, 8)
  preimage.set(clear, 8 + approval.length)
  return sha256(preimage)
}

/**
 * Verify that the configured Registry expects this SDK's Campaign program hash; a mismatch would create a campaign that `register` rejects. No-op when no Registry is configured.
 *
 * @throws {Error} When the Registry expects another bundle, or its hash cannot be read.
 */
export async function verifyDeployment(): Promise<void> {
  const { algorand, registryAppId } = getSdkConfig()
  if (registryAppId === 0n) return
  let registryHash: Uint8Array | undefined
  try {
    const registry = new RegistryClient({ algorand, appId: registryAppId })
    registryHash = (await registry.state.global.campaignProgramHash()).asByteArray()
  } catch (error) {
    const classified = classifyChainError(error, { operation: 'verifyDeployment', appId: registryAppId })
    const message = `could not read the Registry campaign program hash: ${classified.message}`
    throw new SdkError(classified.kind, message, {
      operation: 'verifyDeployment',
      appId: registryAppId,
      ...(classified.code === undefined ? {} : { code: classified.code }),
      cause: error,
      details: error,
    })
  }
  const expectedHash = campaignProgramHash()
  if (registryHash === undefined || bytesToHex(registryHash) !== bytesToHex(expectedHash)) {
    const registryHex = registryHash === undefined ? 'missing' : bytesToHex(registryHash)
    throw new SdkError(
      'registry-mismatch',
      `the Registry expects Campaign program hash ${registryHex}, but this SDK ships contracts ${SPECS_VERSION} (${bytesToHex(expectedHash)})`,
      { operation: 'verifyDeployment', appId: registryAppId },
    )
  }
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
  if (titleBytes.length === 0) {
    throw new SdkError('validation', 'title is required', { operation: 'createCampaign' })
  }
  if (titleBytes.length > MAX_TITLE_BYTES) {
    throw new SdkError('validation', `title must be at most ${String(MAX_TITLE_BYTES)} bytes`, { operation: 'createCampaign' })
  }
  const metadataUriBytes = new TextEncoder().encode(metadataUri)
  if (metadataUriBytes.length > MAX_METADATA_URI_BYTES) {
    throw new SdkError('validation', `metadata URI must be at most ${String(MAX_METADATA_URI_BYTES)} bytes`, {
      operation: 'createCampaign',
    })
  }
  if (goalMicroAlgos < MIN_GOAL_MICRO_ALGOS || goalMicroAlgos > MAX_GOAL_MICRO_ALGOS) {
    throw new SdkError(
      'validation',
      `goal must be between ${String(MIN_GOAL_MICRO_ALGOS)} and ${String(MAX_GOAL_MICRO_ALGOS)} microAlgos`,
      { operation: 'createCampaign' },
    )
  }
  const now = await fetchChainTimestamp()
  const earliestDeadline = now + BigInt(MIN_CAMPAIGN_DURATION_SECONDS)
  const latestDeadline = now + BigInt(MAX_CAMPAIGN_DURATION_SECONDS)
  if (deadlineSeconds < earliestDeadline || deadlineSeconds > latestDeadline) {
    throw new SdkError(
      'validation',
      `deadline must be between ${String(earliestDeadline)} and ${String(latestDeadline)} (chain time ${String(now)})`,
      { operation: 'createCampaign' },
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
      const registerResult = await submitWithClassification('registerCampaign', () => sendRegister(appId, session), appId)
      registerTxIds = registerResult.txIds
    } catch (error) {
      if (!isAlreadyRegisteredError(error)) {
        registered = false
        registerError = classifyChainError(error).message
      }
    }
  }

  // Best-effort: both writes are confirmed; the next read retries if the indexer is briefly behind.
  await waitForIndexerCatchUpBestEffort()

  return {
    ...confirmation,
    appId,
    appAddress,
    registered,
    ...(registerError === undefined ? {} : { registerError }),
    ...(registerTxIds === undefined ? {} : { registerTxIds }),
  }
}
