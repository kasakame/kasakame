import { createHash } from 'node:crypto'

/** The compiled bytecode fields of an ARC-56 contract spec. */
export interface CompiledProgram {
  name?: string
  byteCode?: { approval: string; clear: string }
}

/**
 * The official program hash: `sha256(itob(approval.length) ‖ approval ‖ clear)`; the length prefix binds the split, and `Registry.register` verifies this exact formula.
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

/**
 * Hash the bytecode embedded in an ARC-56 spec.
 *
 * @param spec The compiled ARC-56 spec.
 * @param name Fallback name for the missing-bytecode error.
 * @returns The 32-byte program hash.
 */
export function specProgramHash(spec: CompiledProgram, name: string): Uint8Array {
  if (spec.byteCode === undefined) {
    throw new Error(`${spec.name ?? name} has no byteCode; run \`npm run build\` first.`)
  }
  return programHash(Buffer.from(spec.byteCode.approval, 'base64'), Buffer.from(spec.byteCode.clear, 'base64'))
}
