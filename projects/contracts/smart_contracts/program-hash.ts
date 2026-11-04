import { createHash } from 'node:crypto'

/**
 * The official Campaign program hash: `sha256(itob(approval.length) ‖ approval ‖ clear)`.
 *
 * The 8-byte length prefix binds the approval/clear split; without it, moving bytes between the two programs leaves the
 * concatenation - and therefore the hash - unchanged. `Factory.register` verifies this exact formula, and the vault
 * deploy script sets it on the Factory, so every producer and verifier must share this helper.
 *
 * @param approval The approval program bytes.
 * @param clear The clear-state program bytes.
 * @returns The 32-byte SHA-256 digest.
 */
export function programHash(approval: Uint8Array, clear: Uint8Array): Uint8Array {
  const approvalLength = Buffer.alloc(8)
  approvalLength.writeBigUInt64BE(BigInt(approval.length))
  return createHash('sha256').update(approvalLength).update(approval).update(clear).digest()
}
