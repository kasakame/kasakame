import { microAlgos } from '@algorandfoundation/algokit-utils'
import { CREDIT_EXTRA_INNERS, MAX_PLEDGE_MICRO_ALGOS, MIN_PLEDGE_MICRO_ALGOS } from '@kasakame/constants'
import type { TransactionWithSigner } from 'algosdk'
import { hexToBytes } from 'algosdk'
import { getSdkConfig, waitForIndexerCatchUp, waitForIndexerRound } from '../chain.js'
import type { BackerLeaf } from '../claim-tree/index.js'
import { MAX_TREE_SIZE, clearTreeCache, frontierForPledge, loadTree, pathBlobForRefund, pledgeOpUpIterations } from '../claim-tree/index.js'
import { registrationBox } from './campaign.js'
import type { TransactionComposer, WalletSession } from './clients.js'
import { campaignClientFor, vaultClientFor } from './clients.js'
import { submitWithFreshProof } from './errors.js'
import { minimumFee, spendExtraFee } from './fees.js'
import { vaultAddress, vaultBoxRef } from './vault.js'

/**
 * Build the pledge group without sending it: atomic `[pay, campaign.pledge, vault.credit]` with a freshly rebuilt frontier, after the indexer catches up since lag costs the user an approval plus burned fees.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param amountMicroAlgos Pledge amount in microAlgos.
 * @returns The composer holding the group, ready to build or send.
 */
async function buildPledgeGroup(appId: bigint, session: WalletSession, amountMicroAlgos: bigint): Promise<TransactionComposer> {
  const { algorand, registryAppId, vaultAppId } = getSdkConfig()
  if (amountMicroAlgos < MIN_PLEDGE_MICRO_ALGOS || amountMicroAlgos > MAX_PLEDGE_MICRO_ALGOS) {
    throw new Error(`pledge amount must be between ${String(MIN_PLEDGE_MICRO_ALGOS)} and ${String(MAX_PLEDGE_MICRO_ALGOS)} microAlgos`)
  }
  const minFee = await minimumFee(algorand)
  // The manual composer resolves signers by sender address - register the wallet signer for this address first.
  algorand.account.setSigner(session.address, session.signer)
  await waitForIndexerCatchUp()
  const tree = await loadTree(appId, vaultAppId, vaultAddress())
  const n = BigInt(tree.leaves.length)
  if (n >= MAX_TREE_SIZE) {
    throw new Error('campaign reached its maximum size; it can no longer accept pledges')
  }
  const campaignClient = campaignClientFor(appId, session)
  const vaultClient = vaultClientFor(session)
  const composer = algorand.send.newGroup()
  composer.addAppCallMethodCall(
    await campaignClient.params.pledge({
      args: {
        payment: await algorand.createTransaction.payment({
          sender: session.address,
          receiver: vaultAddress(),
          amount: microAlgos(amountMicroAlgos),
        }),
        frontier: frontierForPledge(tree),
      },
      sender: session.address,
      extraFee: microAlgos(BigInt(pledgeOpUpIterations(n)) * minFee),
    }),
  )
  composer.addAppCallMethodCall(
    await vaultClient.params.credit({
      args: { app: appId, amount: amountMicroAlgos },
      sender: session.address,
      // The first-touch registration check runs inside the vault; the campaign app is the pledge txn before this call.
      appReferences: [registryAppId],
      boxReferences: [...vaultBoxRef(appId), ...registrationBox(appId)],
      extraFee: microAlgos(CREDIT_EXTRA_INNERS * minFee),
    }),
  )
  return composer
}

/**
 * Build the pledge group without sending it; transactions come back unsigned with the session signer attached, and `pledge` is the build-and-send wrapper.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param amountMicroAlgos Pledge amount in microAlgos.
 * @returns The unsigned group.
 */
export async function pledgeGroup(appId: bigint, session: WalletSession, amountMicroAlgos: bigint): Promise<TransactionWithSigner[]> {
  return (await buildPledgeGroup(appId, session, amountMicroAlgos)).build().then((built) => built.transactions)
}

/**
 * Pledge ALGO: build the group with `pledgeGroup` and send it, retrying once when a concurrent pledge moved the frontier.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param amountMicroAlgos Pledge amount in microAlgos.
 */
export async function pledge(appId: bigint, session: WalletSession, amountMicroAlgos: bigint): Promise<void> {
  const attempt = async (): Promise<bigint | undefined> => {
    const composer = await buildPledgeGroup(appId, session, amountMicroAlgos)
    await composer.send()
    return undefined
  }

  await submitWithFreshProof(attempt)
  // Our own write superseded the cache: drop it so the UI reload below refetches.
  clearTreeCache()
  await waitForIndexerCatchUp()
}

/**
 * Withdraw one pledge before the deadline (backer, while the campaign is open), waiting for the indexer and retrying once when a concurrent spend moved the root.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 */
export async function cancelPledge(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<void> {
  const { algorand, vaultAppId } = getSdkConfig()
  // The AppClient drops defaultSigner when sender is passed explicitly (string vs Address identity check), so register globally like pledge/delete.
  algorand.account.setSigner(session.address, session.signer)
  const minFee = await minimumFee(algorand)
  const attempt = async (): Promise<bigint | undefined> => {
    await waitForIndexerCatchUp()
    const tree = await loadTree(appId, vaultAppId, vaultAddress())
    const client = campaignClientFor(appId, session)
    const result = await client.send.cancelPledge({
      args: {
        k: leaf.position,
        amount: leaf.amount,
        txid: hexToBytes(leaf.txidHex),
        path: pathBlobForRefund(tree, leaf.position),
      },
      sender: session.address,
      appReferences: [vaultAppId],
      boxReferences: vaultBoxRef(appId),
      extraFee: microAlgos(spendExtraFee(tree, leaf.position, 2, minFee)),
    })
    return result.confirmation.confirmedRound
  }

  const confirmedRound = await submitWithFreshProof(attempt)
  // Our own write superseded the cache: drop it so the UI reload below refetches.
  clearTreeCache()
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}
