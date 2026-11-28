import { microAlgos } from '@algorandfoundation/algokit-utils'
import { DELETE_EXTRA_INNERS, UNREGISTER_EXTRA_INNERS } from '@kasakame/constants'
import { getSdkConfig } from '../runtime/config.js'
import { waitForIndexerCatchUpBestEffort } from '../runtime/indexer.js'
import type { WalletSession } from './clients.js'
import { campaignClientFor, registryClientFor } from './clients.js'
import type { WriteConfirmation } from './confirmation.js'
import { writeConfirmation } from './confirmation.js'
import { logWriteConfirmed, submitWithClassification } from './errors.js'
import { minimumFee } from './fees.js'
import { fetchVaultConfig, vaultBoxRef } from './vault.js'

/**
 * Delete a settled campaign (creator only): settle the vault, close the escrow, and unregister first; the vault supplies the Registry id when the session has none.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @returns The confirmed transaction ids, round, and app id.
 */
export async function deleteCampaign(appId: bigint, session: WalletSession): Promise<WriteConfirmation> {
  const { algorand, registryAppId, vaultAppId } = getSdkConfig()
  const minFee = await minimumFee(algorand)
  const client = campaignClientFor(appId, session)
  // The manual composer resolves signers by sender address - register the wallet signer for this address first.
  algorand.account.setSigner(session.address, session.signer)
  const composer = algorand.send.newGroup()
  const effectiveRegistryId = registryAppId > 0n ? registryAppId : (await fetchVaultConfig()).registryAppId
  if (effectiveRegistryId > 0n) {
    const registryClient = registryClientFor(session, effectiveRegistryId)
    composer.addAppCallMethodCall(
      await registryClient.params.unregister({
        args: { app: appId },
        sender: session.address,
        appReferences: [appId],
        extraFee: microAlgos(UNREGISTER_EXTRA_INNERS * minFee),
      }),
    )
  }
  composer.addAppCallMethodCall(
    await client.params.delete.delete({
      args: [],
      sender: session.address,
      appReferences: [vaultAppId],
      boxReferences: vaultBoxRef(appId),
      extraFee: microAlgos(DELETE_EXTRA_INNERS * minFee),
    }),
  )
  const result = await submitWithClassification('deleteCampaign', () => composer.send(), appId)
  await waitForIndexerCatchUpBestEffort()
  const confirmation = writeConfirmation(result, { appId })
  logWriteConfirmed('deleteCampaign', appId, confirmation)
  return confirmation
}
