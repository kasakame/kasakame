import { getApplicationAddress } from 'algosdk'
import { getSdkConfig } from '../../runtime/config.js'
import type { TreeState } from '../tree.js'
import { appendLeaf, emptyTree, nullLeaf } from '../tree.js'
import { fetchPledges, fetchSpends } from './events.js'

/** The viewer's live leaf: an unspent pledge position they own, with the payment TxID a proof needs. */
export interface BackerLeaf {
  /** Leaf position in the campaign tree. */
  position: number
  /** Pledged amount, in microAlgos. */
  amount: bigint
  /** Pledge payment transaction ID, hex. */
  txidHex: string
}

/**
 * Load a campaign's full tree state from the indexer: replay pledges in chain order, then null every spent position.
 *
 * @param campaignId Campaign application id.
 * @param vaultId Vault application id.
 * @param vaultAddress Vault app address (the pledge payment receiver).
 * @returns The live tree state.
 */
export async function loadTree(campaignId: bigint, vaultId: bigint, vaultAddress: string): Promise<TreeState> {
  const pledges = await fetchPledges(campaignId, vaultAddress)
  let state = emptyTree()
  for (const pledge of pledges) {
    state = appendLeaf(state, { backer: pledge.backer, amount: pledge.amount, txidHex: pledge.txidHex })
  }
  const amounts = new Map(pledges.map((p, index) => [index, p.amount] as const))
  for (const spend of await fetchSpends(campaignId, vaultId)) {
    const amount = amounts.get(spend.position) ?? 0n
    state = nullLeaf(state, spend.position, amount)
  }
  return state
}

/**
 * The viewer's live leaves: pledge positions they own whose leaf is not yet nulled, driving per-leaf refund/cancel buttons and the pledge total.
 *
 * @param campaignId Campaign application id.
 * @param address Viewer address.
 * @returns Live leaves owned by the viewer, with positions, amounts, and payment TxIDs for proofs.
 */
export async function fetchMyLeaves(campaignId: bigint, address: string): Promise<BackerLeaf[]> {
  const { vaultAppId } = getSdkConfig()
  const vaultAddress = getApplicationAddress(vaultAppId).toString()
  const pledges = await fetchPledges(campaignId, vaultAddress)
  const spent = new Set((await fetchSpends(campaignId, vaultAppId)).map((spend) => spend.position))
  return pledges
    .map((pledge, index) => ({ ...pledge, position: index }))
    .filter((pledge) => pledge.backer === address && !spent.has(pledge.position))
    .map(({ position, amount, txidHex }) => ({ position, amount, txidHex }))
}
