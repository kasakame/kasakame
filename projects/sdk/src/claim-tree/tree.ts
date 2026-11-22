import { LEAF_DOMAIN_HEX } from '@kasakame/constants'
import { sha512_256 } from '@noble/hashes/sha2.js'
import { decodeAddress, hexToBytes } from 'algosdk'

/** A pledge as the tree sees it: the three leaf preimage fields. */
export interface PledgeRecord {
  /** Backer address (decoded to 32 bytes for the leaf). */
  backer: string
  /** Pledged amount, in microAlgos. */
  amount: bigint
  /** Pledge payment transaction ID, hex. */
  txidHex: string
}

/** Tree working state: live leaves (or `Z` once nulled) in position order, plus the live total. */
export interface TreeState {
  /** Leaf values by position (`Z` = 32 zero bytes once nulled); `n = leaves.length`. */
  leaves: Uint8Array[]
  /** Live pledge total, in microAlgos. */
  raised: bigint
}

/**
 * A fresh consumed-leaf marker (32 zero bytes). Returned new each call - never mutate the result.
 *
 * @returns 32 zero bytes.
 */
export function zeroLeaf(): Uint8Array {
  return new Uint8Array(32)
}

/**
 * Hash two child nodes into their parent.
 *
 * @param left Left child.
 * @param right Right child.
 * @returns The parent node.
 */
export function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const preimage = new Uint8Array(left.length + right.length)
  preimage.set(left, 0)
  preimage.set(right, left.length)
  return sha512_256(preimage)
}

/**
 * Encode an unsigned 64-bit integer big-endian.
 *
 * @param value The value (must fit in 64 bits).
 * @returns 8 bytes big-endian.
 */
export function u64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  let v = value
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/**
 * Decode 8 bytes big-endian.
 *
 * @param value Exactly 8 bytes.
 * @returns The decoded bigint.
 */
export function u64beDecode(value: Uint8Array): bigint {
  if (value.length !== 8) throw new Error(`bad uint64 length: ${value.length.toString()}`)
  let v = 0n
  for (const byte of value) v = (v << 8n) | BigInt(byte)
  return v
}

/**
 * Build a pledge leaf: `H(0x01 ‖ backer ‖ amount-be64 ‖ txid)`.
 *
 * @param backer Backer address (checksum-validated by decoding).
 * @param amount Pledged amount, in microAlgos.
 * @param txidHex Pledge payment transaction ID, hex.
 * @returns The leaf value.
 */
export function leafFor(backer: string, amount: bigint, txidHex: string): Uint8Array {
  const preimage = new Uint8Array(1 + 32 + 8 + 32)
  preimage[0] = Number.parseInt(LEAF_DOMAIN_HEX, 16)
  preimage.set(decodeAddress(backer).publicKey, 1)
  preimage.set(u64be(amount), 33)
  preimage.set(hexToBytes(txidHex), 41)
  return sha512_256(preimage)
}

/**
 * An empty tree.
 *
 * @returns Tree state with no positions and zero raised.
 */
export function emptyTree(): TreeState {
  return { leaves: [], raised: 0n }
}

/**
 * Append one pledge leaf (frontier merge cascade), returning new state.
 *
 * @param state Current tree state (not mutated).
 * @param pledge The pledge record.
 * @returns The new tree state.
 */
export function appendLeaf(state: TreeState, pledge: PledgeRecord): TreeState {
  const leaf = leafFor(pledge.backer, pledge.amount, pledge.txidHex)
  const peaks = treeFrontier(state)
  // Merge cascade over the trailing ones of N: the first t peaks fold into the leaf, lowest first.
  let merged = leaf
  const t = trailingOnes(BigInt(state.leaves.length))
  for (const peak of peaks.slice(0, t)) {
    merged = hashPair(peak, merged)
  }
  return { leaves: [...state.leaves, leaf], raised: state.raised + pledge.amount }
}

/**
 * Trailing one-bits of n (the merge cascade length).
 *
 * @param n The value.
 * @returns The trailing-ones count.
 */
function trailingOnes(n: bigint): number {
  let t = 0
  while ((n >> BigInt(t)) & 1n) t += 1
  return t
}

/**
 * Fold ascending peaks into the single stored root (acc = highest; acc = H(acc ‖ peak) descending).
 *
 * @param peaks Ascending peak values.
 * @returns The fold root (`Z` while empty).
 */
export function foldPeaks(peaks: Uint8Array[]): Uint8Array {
  if (peaks.length === 0) return zeroLeaf()
  return peaks.reduceRight((acc, peak) => hashPair(acc, peak))
}

/**
 * The frontier peaks of the current leaves, ascending level order.
 *
 * @param state Current tree state.
 * @returns The ascending peaks.
 */
export function treeFrontier(state: TreeState): Uint8Array[] {
  return peaksWithLevels(state.leaves.length, buildNodes(state.leaves)).map((peak) => peak.value)
}

/**
 * The single stored root for the current leaves.
 *
 * @param state Current tree state.
 * @returns The fold root (`Z` while empty).
 */
export function treeRoot(state: TreeState): Uint8Array {
  return foldPeaks(treeFrontier(state))
}

/**
 * Null one position (in-place consumption marker), returning new state.
 *
 * @param state Current tree state (not mutated).
 * @param position Position to null.
 * @param amount Pledged amount committed by the leaf (decremented from raised).
 * @returns The new tree state.
 */
export function nullLeaf(state: TreeState, position: number, amount: bigint): TreeState {
  if (position < 0 || position >= state.leaves.length) throw new RangeError(`unknown position: ${position.toString()}`)
  const leaves = [...state.leaves]
  leaves[position] = zeroLeaf()
  return { leaves, raised: state.raised - amount }
}

/**
 * All full nodes: rows[l][i]; row l holds floor(n / 2^l) entries (odd leftovers dropped, never carried).
 *
 * @param leaves Leaf values in position order.
 * @returns Node rows by level.
 */
export function buildNodes(leaves: Uint8Array[]): Uint8Array[][] {
  const n = leaves.length
  const nodes: Uint8Array[][] = [leaves]
  let prev = leaves
  for (let l = 1; 2 ** l <= n; l++) {
    const count = Math.floor(n / 2 ** l)
    const level: Uint8Array[] = []
    for (let i = 0; i < count; i++) {
      // Indices provably in range (count = floor(n / 2^l) over a row of exactly that many pairs).
      const [left, right] = prev.slice(2 * i, 2 * i + 2) as [Uint8Array, Uint8Array]
      level.push(hashPair(left, right))
    }
    nodes.push(level)
    prev = level
  }
  return nodes
}

/**
 * Ascending frontier peaks for size n: `nodes[l][(n >> l) - 1]` for each set bit l, with levels attached.
 *
 * @param n Tree size.
 * @param nodes Node rows from `buildNodes`.
 * @returns Peaks with levels, ascending.
 */
export function peaksWithLevels(n: number, nodes: Uint8Array[][]): { value: Uint8Array; level: number }[] {
  const peaks: { value: Uint8Array; level: number }[] = []
  nodes.forEach((row, level) => {
    if (Math.floor(n / 2 ** level) % 2 === 0) return
    // Index provably in range (the set bit guarantees a full block row of exactly this many entries).
    const [peak] = row.slice(Math.floor(n / 2 ** level) - 1) as [Uint8Array]
    peaks.push({ value: peak, level })
  })
  return peaks
}
