import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { TransactionWithSigner } from 'algosdk'
import { clearTreeCache, waitForIndexerCatchUp } from '../../src/index.js'

/**
 * Submit a pre-built SDK group and refresh the indexer caches.
 *
 * @param algorand The configured LocalNet client.
 * @param group The transactions and their signers.
 */
export async function submitGroup(algorand: AlgorandClient, group: TransactionWithSigner[]): Promise<void> {
  const composer = algorand.send.newGroup()
  for (const transaction of group) composer.addTransaction(transaction.txn, transaction.signer)
  await composer.send()
  clearTreeCache()
  await waitForIndexerCatchUp()
}
