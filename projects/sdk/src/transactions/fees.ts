import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { TreeState } from '../claim-tree/index.js'
import { refundOpUpIterations } from '../claim-tree/index.js'

// Fee headroom per call: the outer call covers its inners via fee pooling, so every extra inner transaction costs one
// more current minimum fee. The counts are group-shape facts; the price comes from SuggestedParams.minFee at runtime.

/**
 * Read the current minimum transaction fee. `AlgorandClient` caches suggested params, so this does not add a network
 * call per group.
 *
 * @param algorand The configured Algorand client.
 * @returns The minimum fee in microAlgos.
 */
export async function minimumFee(algorand: AlgorandClient): Promise<bigint> {
  const { minFee } = await algorand.getSuggestedParams()
  return BigInt(minFee)
}

/**
 * Extra fee for a spend: the payout inner transactions for this path plus one minimum fee per OpUp iteration the
 * contract will request.
 *
 * @param tree Current tree (its length is N).
 * @param position Leaf position.
 * @param payoutInners 2 for the campaign path (`payBack` app call + payment), 1 for the vault path (payment).
 * @param minFee Current minimum transaction fee in microAlgos.
 * @returns The extra fee in microAlgos.
 */
export function spendExtraFee(tree: TreeState, position: number, payoutInners: 1 | 2, minFee: bigint): bigint {
  const iterations = refundOpUpIterations(BigInt(tree.leaves.length), BigInt(position))
  return (BigInt(payoutInners) + BigInt(iterations)) * minFee
}
