import { clearTreeCache } from '../claim-tree/index.js'

// Contract asserts for stale Merkle proofs (`campaign/contract.algo.ts`, `claimsvault/contract.algo.ts`): plain
// strings, but ours and stable - covered by contract tests when they change.
const STALE_PROOF_PATTERN = /stale or forged frontier|proof does not match root/i

/**
 * Whether a submission failed on a stale Merkle proof (a concurrent pledge/refund moved the root).
 *
 * @param error The failure from a chain submission.
 * @returns True when rebuilding proofs and retrying once is correct.
 */
export function isStaleProofError(error: unknown): boolean {
  return error instanceof Error && STALE_PROOF_PATTERN.test(error.message)
}

/**
 * Run a proof-carrying submission, rebuilding proofs once when the tree moved under us (concurrent pledge/refund
 * changed the root between our read and our submit). Anything else throws immediately.
 *
 * @param run Builds fresh proofs from a fresh tree, then submits. Called up to twice.
 * @returns The confirmed round, if exposed.
 */
export async function submitWithFreshProof(run: () => Promise<bigint | undefined>): Promise<bigint | undefined> {
  try {
    clearTreeCache()
    return await run()
  } catch (error) {
    if (isStaleProofError(error)) {
      clearTreeCache()
      return await run()
    }
    throw error
  }
}
