import type algosdk from 'algosdk'
import { bytesToHex } from 'algosdk'
import { getSdkConfig } from '../../runtime/config.js'
import { base32ToBytes } from '../proof.js'
import { SELECTOR_CANCEL, SELECTOR_PLEDGE, SELECTOR_REFUND, SELECTOR_VAULT_REFUND } from '../selectors.js'
import type { PledgeRecord } from '../tree.js'
import { u64beDecode } from '../tree.js'
import { BLOCK_LOOKUP_CHUNK, appCallCache, blockCache, cached } from './cache.js'

/** A confirmed pledge call with its paired payment, in chain order. */
export interface PledgeEvent extends PledgeRecord {
  /** Confirmed round of the pledge group. */
  round: bigint
}

/** A confirmed spend (cancel, campaign refund, or vault refund): only the position matters for replay. */
export interface SpendEvent {
  /** Nulled position. */
  position: number
}

/**
 * Method selector (first 4 bytes, hex) of an app call's args.
 *
 * @param args Application args, selector first.
 * @returns The selector hex, or undefined when absent.
 */
function selectorOf(args: Uint8Array[] | undefined): string | undefined {
  const first = args?.[0]
  if (!first || first.length < 4) return undefined
  return bytesToHex(first.subarray(0, 4))
}

/**
 * All confirmed app calls to one app, paginated.
 *
 * @param appId Application id.
 * @returns Every matching transaction.
 */
async function searchAppCalls(appId: bigint): Promise<algosdk.indexerModels.Transaction[]> {
  return cached(appCallCache, appId, async () => {
    const indexer = getSdkConfig().algorand.client.indexer
    const calls: algosdk.indexerModels.Transaction[] = []
    let nextToken: string | undefined
    do {
      let query = indexer.searchForTransactions().applicationID(appId).limit(1000)
      if (nextToken !== undefined) query = query.nextToken(nextToken)
      const response = await query.do()
      calls.push(...response.transactions)
      nextToken = response.nextToken
    } while (nextToken !== undefined)
    return calls
  })
}

/**
 * Fetch confirmed pledge calls for a campaign, oldest first; each pairs with the nearest preceding caller payment to the vault, and a missing payment throws.
 *
 * @param campaignId Campaign application id.
 * @param vaultAddress Vault app address (the payment receiver).
 * @returns Pledge events in append (position) order.
 */
export async function fetchPledges(campaignId: bigint, vaultAddress: string): Promise<PledgeEvent[]> {
  const indexer = getSdkConfig().algorand.client.indexer
  const calls = (await searchAppCalls(campaignId)).filter((t) => selectorOf(t.applicationTransaction?.applicationArgs) === SELECTOR_PLEDGE)
  const byRound = new Map<bigint, typeof calls>()
  for (const call of calls) {
    if (call.confirmedRound === undefined) continue
    const list = byRound.get(call.confirmedRound) ?? []
    list.push(call)
    byRound.set(call.confirmedRound, list)
  }
  const pledges: PledgeEvent[] = []
  const rounds = [...byRound.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const withBlocks: { round: bigint; roundCalls: typeof calls; block: { transactions?: algosdk.indexerModels.Transaction[] } }[] = []
  for (let index = 0; index < rounds.length; index += BLOCK_LOOKUP_CHUNK) {
    const chunk = rounds.slice(index, index + BLOCK_LOOKUP_CHUNK)
    withBlocks.push(
      ...(await Promise.all(
        chunk.map(async ([round, roundCalls]) => ({
          round,
          roundCalls,
          block: await cached(blockCache, round, () => indexer.lookupBlock(round).do()),
        })),
      )),
    )
  }
  for (const { round, roundCalls, block } of withBlocks) {
    const txns = block.transactions ?? []
    const positionOf = new Map<string, number>()
    txns.forEach((txn, index) => {
      if (txn.id !== undefined) positionOf.set(txn.id, index)
    })
    const ordered = [...roundCalls].sort((a, b) => (positionOf.get(a.id ?? '') ?? 0) - (positionOf.get(b.id ?? '') ?? 0))
    for (const call of ordered) {
      const callIndex = positionOf.get(call.id ?? '')
      // A confirmed call is always in its round's block; absence means a torn indexer read - fail loudly rather than shift later positions.
      if (callIndex === undefined) {
        throw new Error(`pledge call ${call.id ?? 'unknown'} not found in its round block`)
      }
      let payment: { id: string; amount: bigint } | undefined
      for (const candidate of txns.slice(0, callIndex).reverse()) {
        if (candidate.sender !== call.sender) continue
        const payFields = candidate.paymentTransaction
        if (payFields === undefined || payFields.receiver !== vaultAddress) continue
        if (payFields.amount <= 0n) continue
        const pid = candidate.id
        if (pid === undefined) continue
        payment = { id: pid, amount: payFields.amount }
        break
      }
      if (payment === undefined) {
        // An id-less call always fails the block-index check above, so the fallback never fires.
        /* v8 ignore next */
        throw new Error(`pledge call ${call.id ?? 'unknown'} has no paired payment in round ${round.toString()}`)
      }
      pledges.push({
        backer: call.sender,
        amount: payment.amount,
        txidHex: bytesToHex(base32ToBytes(payment.id)),
        round,
      })
    }
  }
  return pledges
}

/**
 * Fetch confirmed spends (campaign cancels/refunds plus vault refunds); only positions matter for replay, so no block reads are needed.
 *
 * @param campaignId Campaign application id.
 * @param vaultId Vault application id.
 * @returns Spent positions.
 */
export async function fetchSpends(campaignId: bigint, vaultId: bigint): Promise<SpendEvent[]> {
  const spends: SpendEvent[] = []
  const [campaignCalls, vaultCalls] = await Promise.all([searchAppCalls(campaignId), searchAppCalls(vaultId)])
  for (const call of campaignCalls) {
    const args = call.applicationTransaction?.applicationArgs
    const selector = selectorOf(args)
    if (selector !== SELECTOR_CANCEL && selector !== SELECTOR_REFUND) continue
    const rawK = args?.[1]
    if (rawK === undefined) continue
    spends.push({ position: Number(u64beDecode(rawK)) })
  }
  for (const call of vaultCalls) {
    const args = call.applicationTransaction?.applicationArgs
    if (selectorOf(args) !== SELECTOR_VAULT_REFUND) continue
    const rawApp = args?.[1]
    const rawK = args?.[2]
    if (rawApp === undefined || rawK === undefined) continue
    if (u64beDecode(rawApp) !== campaignId) continue
    spends.push({ position: Number(u64beDecode(rawK)) })
  }
  return spends
}
