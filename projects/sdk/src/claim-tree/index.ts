/**
 * Claim-tree math and indexer replay, proven against docs/claim-tree-protocol-reference.py; hashes use SHA-512/256 (the AVM `sha512_256` opcode, not plain SHA-256).
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
