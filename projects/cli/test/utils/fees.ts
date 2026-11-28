import { refundOpUpIterations } from '@kasakame/sdk'

/**
 * The SDK's campaign-routed spend fee: outer + two payout inners, plus OpUp takes.
 *
 * @param minFee The LocalNet minimum fee.
 * @param treeSize The tree size at spend time.
 * @param position The leaf position.
 * @returns The fee in microAlgos.
 */
export function campaignSpendFee(minFee: bigint, treeSize: bigint, position: bigint): bigint {
  return (3n + BigInt(refundOpUpIterations(treeSize, position))) * minFee
}

/**
 * The SDK's vault-routed refund fee: outer + one payout inner, plus OpUp takes.
 *
 * @param minFee The LocalNet minimum fee.
 * @param treeSize The tree size at refund time.
 * @param position The leaf position.
 * @returns The fee in microAlgos.
 */
export function vaultSpendFee(minFee: bigint, treeSize: bigint, position: bigint): bigint {
  return (2n + BigInt(refundOpUpIterations(treeSize, position))) * minFee
}
