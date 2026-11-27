/** Result of a confirmed write: transaction ids, round, and the operation-specific facts. */
export interface WriteConfirmation {
  /** Base32 transaction ids for the confirmed group (the primary transaction first). */
  txIds: string[]
  /** Round the group was confirmed in, when the node returned it. */
  confirmedRound?: bigint
  /** Campaign or other application id the write touched. */
  appId?: bigint
  /** Leaf position for a pledge, cancel, or refund. */
  position?: number
  /** Amount in microAlgos for a pledge, cancel, or refund; the residual for finalize. */
  amount?: bigint
}

/** The confirmation fields a generated-client or composer send result exposes. */
interface WriteResult {
  txIds?: string[]
  confirmations?: { confirmedRound?: bigint }[]
  confirmation?: { confirmedRound?: bigint }
}

/**
 * Build a write confirmation from a generated-client or composer send result.
 *
 * @param result A send result with txIds and a single confirmation or a confirmations array.
 * @param extra Operation-specific fields.
 * @returns The confirmation.
 */
export function writeConfirmation(result: WriteResult, extra: Omit<WriteConfirmation, 'txIds' | 'confirmedRound'> = {}): WriteConfirmation {
  const confirmedRound = result.confirmations?.[0]?.confirmedRound ?? result.confirmation?.confirmedRound
  return {
    txIds: result.txIds ?? [],
    ...(confirmedRound === undefined ? {} : { confirmedRound }),
    ...extra,
  }
}
