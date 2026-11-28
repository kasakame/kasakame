import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { TransactionWithSigner } from 'algosdk'
import { hexToBytes } from 'algosdk'
import type { BackerLeaf } from '../claim-tree/index.js'
import { clearTreeCache, loadTree, pathBlobForRefund } from '../claim-tree/index.js'
import { getSdkConfig } from '../runtime/config.js'
import { waitForIndexerCatchUp, waitForIndexerRound } from '../runtime/indexer.js'
import { sdkLogger } from '../runtime/log.js'
import type { TransactionComposer, WalletSession } from './clients.js'
import { campaignClientFor, vaultClientFor, withoutGroupId } from './clients.js'
import type { WriteConfirmation } from './confirmation.js'
import { writeConfirmation } from './confirmation.js'
import { classifyChainError, isCampaignRoutingError, logWriteConfirmed, submitWithFreshProof, throwSdkError } from './errors.js'
import { minimumFee, spendExtraFee } from './fees.js'
import { VAULT_BOX_STATUS_FAILED, fetchVaultBox, vaultAddress, vaultBoxRef } from './vault.js'

/**
 * Build the refund group without sending it, routing by the fresh vault box: `Open`/missing goes through the campaign, `Failed` goes straight to `vault.refund` (covers post-settle and post-delete).
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 * @returns The composer holding the group, ready to build or send.
 */
async function buildRefundGroup(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<TransactionComposer> {
  const { algorand, vaultAppId } = getSdkConfig()
  // Same signer registration as cancelPledge (see above): without it both the campaign and vault paths fail.
  algorand.account.setSigner(session.address, session.signer)
  const minFee = await minimumFee(algorand)
  await waitForIndexerCatchUp()
  const tree = await loadTree(appId, vaultAppId, vaultAddress())
  const path = pathBlobForRefund(tree, leaf.position)
  const txid = hexToBytes(leaf.txidHex)
  const composer = algorand.send.newGroup()
  const box = await fetchVaultBox(appId)
  const vaultRoute = box !== undefined && box.status === VAULT_BOX_STATUS_FAILED
  sdkLogger().debug('refund.route', { appId: appId.toString(), route: vaultRoute ? 'vault' : 'campaign' })
  if (vaultRoute) {
    const vaultClient = vaultClientFor(session)
    composer.addAppCallMethodCall(
      await vaultClient.params.refund({
        args: { app: appId, k: leaf.position, amount: leaf.amount, txid, path },
        sender: session.address,
        boxReferences: vaultBoxRef(appId),
        extraFee: microAlgos(spendExtraFee(tree, leaf.position, 1, minFee)),
      }),
    )
  } else {
    const client = campaignClientFor(appId, session)
    composer.addAppCallMethodCall(
      await client.params.refund({
        args: { k: leaf.position, amount: leaf.amount, txid, path },
        sender: session.address,
        appReferences: [vaultAppId],
        boxReferences: vaultBoxRef(appId),
        extraFee: microAlgos(spendExtraFee(tree, leaf.position, 2, minFee)),
      }),
    )
  }
  return composer
}

/**
 * Build the refund group without sending it - unsigned transactions with the session signer attached; `refund` is the build-and-send wrapper.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 * @returns The unsigned group.
 */
export async function refundGroup(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<TransactionWithSigner[]> {
  const composer = await buildRefundGroup(appId, session, leaf)
  return withoutGroupId((await composer.build()).transactions)
}

/**
 * Refund one pledge after a failed campaign: build the group with `refundGroup` and send it, retrying once when a concurrent spend moved the root.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 * @returns The confirmed transaction ids, round, position, and amount.
 */
export async function refund(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<WriteConfirmation> {
  const attempt = async (): Promise<WriteConfirmation> => {
    const composer = await buildRefundGroup(appId, session, leaf)
    const result = await composer.send()
    return writeConfirmation(result, { position: leaf.position, amount: leaf.amount })
  }

  let confirmation: WriteConfirmation
  try {
    confirmation = await submitWithFreshProof(attempt, 'refund', appId)
  } catch (error) {
    if (!isCampaignRoutingError(error)) {
      throwSdkError(classifyChainError(error, { operation: 'refund', appId }))
    }
    const classified = classifyChainError(error)
    sdkLogger().debug('refund.reroute', {
      appId: appId.toString(),
      type: classified.type,
      ...(classified.code === undefined ? {} : { code: classified.code }),
    })
    // The box settled or the campaign vanished between our read and the send: re-read the box and route once more.
    try {
      confirmation = await submitWithFreshProof(attempt, 'refund', appId)
    } catch (retryError) {
      throwSdkError(classifyChainError(retryError, { operation: 'refund', appId }))
    }
  }
  // Our own write superseded the cache: drop it so the UI reload below refetches.
  clearTreeCache()
  if (confirmation.confirmedRound !== undefined) {
    await waitForIndexerRound(confirmation.confirmedRound)
  }
  logWriteConfirmed('refund', appId, confirmation)
  return confirmation
}
