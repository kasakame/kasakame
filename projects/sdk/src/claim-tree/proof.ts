import type { TreeState } from './tree.js'
import { buildNodes, foldPeaks, peaksWithLevels, treeFrontier } from './tree.js'

/** An authentication path: within-peak siblings (ascending), higher-peak fold (if any), lower peaks (ascending). */
export interface AuthPath {
  siblings: Uint8Array[]
  top: Uint8Array | null
  lower: Uint8Array[]
}

/**
 * The expected path shape for `(n, k)`: first level whose sibling block extends past N, lower-peak count, higher fold.
 * Mirrors the contract's derivation (used for arg-size estimates).
 *
 * @param n Tree size (positions ever appended).
 * @param k Leaf position.
 * @returns Within-peak length r, lower-peak count c, and whether a higher fold exists.
 */
export function pathShape(n: bigint, k: bigint): { r: number; c: number; hasTop: boolean } {
  let r = 0
  for (let level = 0; level < 64; level++) {
    const i = k >> BigInt(level)
    const sib = (i & 1n) === 0n ? i + 1n : i - 1n
    if ((sib + 1n) * 2n ** BigInt(level) <= n) {
      r += 1
    } else {
      break
    }
  }
  const mod = n - ((n >> BigInt(r)) << BigInt(r))
  let c = 0
  let rest = mod
  while (rest > 0n) {
    c += Number(rest & 1n)
    rest >>= 1n
  }
  return { r, c, hasTop: n >> BigInt(r + 1) > 0n }
}

/**
 * The authentication path for position k against the current leaves.
 *
 * @param state Current tree state.
 * @param k Leaf position.
 * @returns Siblings (ascending), higher fold (if any), lower peaks (ascending).
 */
export function treePathFor(state: TreeState, k: number): AuthPath {
  const n = state.leaves.length
  if (k < 0 || k >= n) throw new RangeError(`unknown position: ${k.toString()}`)
  const nodes = buildNodes(state.leaves)
  const { r } = pathShape(BigInt(n), BigInt(k))
  const siblings: Uint8Array[] = []
  nodes.forEach((row, l) => {
    if (l >= r) return
    // Index provably in range (r counts only levels whose sibling block exists).
    const [sib] = row.slice(Number((BigInt(k) >> BigInt(l)) ^ 1n)) as [Uint8Array]
    siblings.push(sib)
  })
  const peaks = peaksWithLevels(n, nodes)
  const higher = peaks.filter((peak) => peak.level > r).map((peak) => peak.value)
  const lower = peaks.filter((peak) => peak.level < r).map((peak) => peak.value)
  return { siblings, top: higher.length === 0 ? null : foldPeaks(higher), lower }
}

/**
 * Concatenate hash values for a contract call arg (frontier or path blob).
 *
 * @param parts The 32-byte values (and empty for a missing top).
 * @returns The concatenated bytes.
 */
export function concatHashes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * The `pledge` frontier arg for the current tree: concatenated ascending peaks (empty while N == 0).
 *
 * @param state Current tree state.
 * @returns The frontier bytes.
 */
export function frontierForPledge(state: TreeState): Uint8Array {
  return concatHashes(treeFrontier(state))
}

/**
 * The single-blob refund path arg (`siblings ‖ top ‖ lower`) for position k.
 *
 * @param state Current tree state.
 * @param k Leaf position.
 * @returns The path blob.
 */
export function pathBlobForRefund(state: TreeState, k: number): Uint8Array {
  const path = treePathFor(state, k)
  return concatHashes([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
}

/** Decode an unpadded RFC 4648 base32 string (confirmed transaction IDs) to bytes. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Decode an unpadded base32 string.
 *
 * @param input Unpadded base32 input.
 * @returns The decoded bytes.
 */
export function base32ToBytes(input: string): Uint8Array {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of input) {
    const digit = BASE32_ALPHABET.indexOf(char)
    if (digit < 0) throw new Error(`bad base32 character: ${char}`)
    value = (value << 5) | digit
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return new Uint8Array(out)
}
