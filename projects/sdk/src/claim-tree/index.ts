/**
 * Claim-tree math and indexer replay: the frontier-Merkle tree a campaign tracks on-chain, plus the read half that
 * reconstructs it from confirmed history.
 *
 * The pure math (leaves, frontier, paths) renders offline so callers can build `pledge` frontiers and `refund` paths
 * without trusting any server: a read-only TypeScript port of `docs/claim-tree-protocol-reference.py` §§2–6, proven
 * against the committed vectors in `claim-tree.vectors.ts`. Hashes use `@noble/hashes` SHA-512/256 - the same
 * function as the AVM `sha512_256` opcode (NOT plain SHA-256).
 *
 * The replay half (`fetchPledges`, `fetchSpends`, `loadTree`, `fetchMyLeaves`) walks the configured indexer (see
 * `chain.ts`) in chain order. Only confirmed transactions are replayed, so every replayed pledge appended on-chain
 * and every replayed spend nulled on-chain - the reconstruction matches contract state exactly.
 *
 * Proof staleness is inherent (every null changes the root): callers rebuild right before submitting and retry once on
 * a root-mismatch rejection. See docs/claim-tree-protocol.md §7.
 */

export { MAX_TREE_SIZE, pledgeOpUpIterations, refundOpUpIterations } from './fees.js'
export { clearTreeCache, fetchMyLeaves, fetchPledges, fetchSpends, loadTree } from './indexer.js'
export type { BackerLeaf, PledgeEvent, SpendEvent } from './indexer.js'
export { base32ToBytes, concatHashes, frontierForPledge, pathBlobForRefund, pathShape, treePathFor } from './proof.js'
export type { AuthPath } from './proof.js'
export {
  appendLeaf,
  emptyTree,
  foldPeaks,
  hashPair,
  leafFor,
  nullLeaf,
  treeFrontier,
  treeRoot,
  u64be,
  u64beDecode,
  zeroLeaf,
} from './tree.js'
export type { PledgeRecord, TreeState } from './tree.js'
