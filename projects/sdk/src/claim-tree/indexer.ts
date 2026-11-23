import type algosdk from 'algosdk'
import { bytesToHex, getApplicationAddress } from 'algosdk'
import { getSdkConfig } from '../chain.js'
import { base32ToBytes } from './proof.js'
import { SELECTOR_CANCEL, SELECTOR_PLEDGE, SELECTOR_REFUND, SELECTOR_VAULT_REFUND } from './selectors.js'
import type { PledgeRecord, TreeState } from './tree.js'
import { appendLeaf, emptyTree, nullLeaf, u64beDecode } from './tree.js'

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

/** The viewer's live leaf: an unspent pledge position they own, with the payment TxID a proof needs. */
export interface BackerLeaf {
  /** Leaf position in the campaign tree. */
  position: number
  /** Pledged amount, in microAlgos. */
  amount: bigint
  /** Pledge payment transaction ID, hex. */
  txidHex: string
}

// Session memo for indexer reads, cleared wholesale by `clearTreeCache` around proof-carrying submissions; one invalidation rule keeps the cost to one re-download per mutation.
const appCallCache = new Map<bigint, Promise<algosdk.indexerModels.Transaction[]>>()
const blockCache = new Map<bigint, Promise<{ transactions?: algosdk.indexerModels.Transaction[] }>>()

/**
 * Drop memoized indexer reads; the SDK's write helpers call it around proof-carrying submissions, plain reads reuse the cache.
 */
export function clearTreeCache(): void {
  appCallCache.clear()
  blockCache.clear()
}

/**
 * Memoized fetch so duplicate and repeat reads reuse one download; only resolved values stick, so a transient failure retries naturally.
 *
 * @param cache Memo map keyed by id.
 * @param key Cache key.
 * @param load The fetch to memoize.
 * @returns The cached or freshly loaded value.
 */
function cached<T>(cache: Map<bigint, Promise<T>>, key: bigint, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const pending = load()
  cache.set(key, pending)
  void pending.catch(() => {
    cache.delete(key)
  })
  return pending
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
 * Fetch confirmed pledge calls for a campaign, oldest first; each pledge pairs with the nearest preceding payment from the caller to the vault in its block, and a missing payment throws rather than corrupt positions.
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
  const withBlocks = await Promise.all(
    rounds.map(async ([round, roundCalls]) => ({
      round,
      roundCalls,
      block: await cached(blockCache, round, () => indexer.lookupBlock(round).do()),
    })),
  )
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
