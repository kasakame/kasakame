import {
  OPUP_AVAILABLE_BUDGET,
  OPUP_BUDGET_PER_ITERATION,
  OPUP_ITERATION_SLACK,
  OPUP_SPEND_NET_BUDGET,
  PLEDGE_BASE_COST,
  PLEDGE_PEAK_COST,
  SPEND_BASE_COST,
  SPEND_ELEMENT_COST,
  SPEND_TOP_UP_OVERHEAD,
} from '@kasakame/constants'
import { pathShape } from './proof.js'

/**
 * Public SDK re-export of the shared cap; import it from `@kasakame/constants` outside the SDK.
 *
 * Maximum campaign tree size (2^19 - 1 = 524,287). Must match `Campaign.MAX_TREE_SIZE`: at the worst-case refund
 * path (r = c = 18, 36 elements) the zero-headroom fee bound funds 15 OpUp takes, while the measured ~600-op prelude
 * makes the contract request 14, so 14 + two payout inners = 16 inner transactions. The extra funded take is never
 * requested.
 */
export { MAX_TREE_SIZE } from '@kasakame/constants'

/**
 * OpUp iterations the campaign will request for a pledge at the current tree size.
 *
 * @param n Tree size (positions ever appended).
 * @returns The number of 700-op budget top-ups.
 */
export function pledgeOpUpIterations(n: bigint): number {
  const required = popcount(n) * PLEDGE_PEAK_COST + PLEDGE_BASE_COST
  return opUpIterations(required, OPUP_AVAILABLE_BUDGET)
}

/**
 * OpUp iterations the campaign or vault will request for a spend at position `k`.
 *
 * @param n Tree size (positions ever appended).
 * @param k Leaf position.
 * @returns The number of 700-op budget top-ups.
 */
export function refundOpUpIterations(n: bigint, k: bigint): number {
  const { r, c, hasTop } = pathShape(n, k)
  const pathElements = r + c + (hasTop ? 1 : 0)
  const required = pathElements * SPEND_ELEMENT_COST + SPEND_BASE_COST
  return Math.max(0, Math.ceil((required + SPEND_TOP_UP_OVERHEAD) / OPUP_SPEND_NET_BUDGET))
}

/**
 * Number of 700-op top-ups needed to reach the contract's required budget.
 *
 * @param required Contract target (`ensureBudget` argument).
 * @param available Conservative pre-top-up budget.
 * @returns The iteration count.
 */
function opUpIterations(required: number, available: number): number {
  return Math.max(0, Math.ceil((required + OPUP_ITERATION_SLACK - available) / OPUP_BUDGET_PER_ITERATION))
}

/**
 * Count set bits in a uint64-sized value.
 *
 * @param n The value.
 * @returns The popcount.
 */
function popcount(n: bigint): number {
  let count = 0
  for (let value = n; value > 0n; value >>= 1n) {
    count += Number(value & 1n)
  }
  return count
}
