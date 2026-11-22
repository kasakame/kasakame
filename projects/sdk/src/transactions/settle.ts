import { microAlgos } from '@algorandfoundation/algokit-utils'
import { CLAIM_EXTRA_INNERS, DELETE_EXTRA_INNERS, UNREGISTER_EXTRA_INNERS } from '@kasakame/constants'
import type { TransactionWithSigner } from 'algosdk'
import { hexToBytes } from 'algosdk'
import { getSdkConfig, waitForIndexerCatchUp, waitForIndexerRound } from '../chain.js'
import type { BackerLeaf } from '../claim-tree/index.js'
import { clearTreeCache, loadTree, pathBlobForRefund } from '../claim-tree/index.js'
import type { TransactionComposer, WalletSession } from './clients.js'
import { campaignClientFor, registryClientFor, vaultClientFor } from './clients.js'
import { submitWithFreshProof } from './errors.js'
import { minimumFee, spendExtraFee } from './fees.js'
import { VAULT_BOX_STATUS_FAILED, fetchVaultBox, vaultAddress, vaultBoxRef } from './vault.js'

/**
 * Build the refund group without sending it. Routes by the vault box (fresh from algod): an `Open`/missing box goes
 * through the campaign, a `Failed` box goes straight to `vault.refund` (covers post-settle and post-delete). Waits
 * for the indexer to catch up before rebuilding the path (see buildPledgeGroup).
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
  if (box !== undefined && box.status === VAULT_BOX_STATUS_FAILED) {
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
 * Build the refund group without sending it - unsigned transactions with the session signer attached, for external
 * signing or inspection. `refund` is the build-and-send wrapper.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 * @returns The unsigned group.
 */
export async function refundGroup(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<TransactionWithSigner[]> {
  return (await buildRefundGroup(appId, session, leaf)).build().then((built) => built.transactions)
}

/**
 * Refund one pledge after a failed campaign: build the group with `refundGroup` and send it. Retries once when a
 * concurrent spend moved the root under us.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 */
export async function refund(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<void> {
  const attempt = async (): Promise<bigint | undefined> => {
    const composer = await buildRefundGroup(appId, session, leaf)
    const result = await composer.send()
    return result.confirmations[0]?.confirmedRound
  }

  const confirmedRound = await submitWithFreshProof(attempt)
  // Our own write superseded the cache: drop it so the UI reload below refetches.
  clearTreeCache()
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Claim the campaign funds (creator only, after deadline, goal reached). The vault pays the derived live total.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function claim(appId: bigint, session: WalletSession): Promise<void> {
  const { algorand, vaultAppId } = getSdkConfig()
  // Same signer registration as pledge (see cancelPledge): without it the send always throws "No signer found".
  algorand.account.setSigner(session.address, session.signer)
  const minFee = await minimumFee(algorand)
  const client = campaignClientFor(appId, session)
  const result = await client.send.claim({
    args: [],
    appReferences: [vaultAppId],
    boxReferences: vaultBoxRef(appId),
    extraFee: microAlgos(CLAIM_EXTRA_INNERS * minFee),
  })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Delete a settled campaign (creator only): settles the vault on the failed path, closes the escrow to the creator,
 * and unregisters from the Registry (returning the registration deposit). One atomic group (one wallet approval):
 * unregister runs first so every app reference resolves while the campaign app still exists, and the Registry requires
 * its `delete()` to be the immediately following transaction. Atomicity makes the order irrelevant to the outcome.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function deleteCampaign(appId: bigint, session: WalletSession): Promise<void> {
  const { algorand, registryAppId, vaultAppId } = getSdkConfig()
  const minFee = await minimumFee(algorand)
  const client = campaignClientFor(appId, session)
  // The manual composer resolves signers by sender address - register the wallet signer for this address first.
  algorand.account.setSigner(session.address, session.signer)
  const composer = algorand.send.newGroup()
  if (registryAppId > 0n) {
    const registryClient = registryClientFor(session)
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
  await composer.send()
  await waitForIndexerCatchUp()
}
