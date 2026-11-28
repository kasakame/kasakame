import { microAlgos } from '@algorandfoundation/algokit-utils'
import { APP_ID_BYTES, REGISTER_DEPOSIT_MICRO_ALGOS, REGISTRY_BOX_PREFIX } from '@kasakame/constants'
import { getSdkConfig } from '../runtime/config.js'
import { waitForIndexerCatchUpBestEffort } from '../runtime/indexer.js'
import { sdkLogger } from '../runtime/log.js'
import type { WalletSession } from './clients.js'
import { registryClientFor } from './clients.js'
import type { WriteConfirmation } from './confirmation.js'
import { writeConfirmation } from './confirmation.js'
import { classifyChainError, classifySubmission, isAlreadyRegisteredError, logWriteConfirmed, throwSdkError } from './errors.js'

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
export async function sendRegister(
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
    confirmation = writeConfirmation(await classifySubmission('registerCampaign', () => sendRegister(appId, session), appId))
  } catch (error) {
    const classified = classifyChainError(error, { operation: 'registerCampaign', appId })
    // A retry can race a registration that landed but whose confirmation was lost.
    if (!isAlreadyRegisteredError(classified)) throwSdkError(classified)
    sdkLogger().debug('register.already-registered', { appId: appId.toString() })
    confirmation = { txIds: [] }
  }
  await waitForIndexerCatchUpBestEffort()
  logWriteConfirmed('registerCampaign', appId, confirmation)
  return confirmation
}
