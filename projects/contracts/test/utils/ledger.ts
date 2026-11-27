import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { accountInfo, assertAccountDelta, type AccountAmounts } from '@kasakame/utils/testing'

/** Balances and minimum balances for the addresses in a snapshot. */
export type ActorSnapshot = Record<string, AccountAmounts>

/**
 * Read the balances and minimum balances of several actors.
 *
 * @param algorand The LocalNet client.
 * @param addresses The addresses to snapshot.
 * @returns The snapshot keyed by address.
 */
export async function actorSnapshot(algorand: AlgorandClient, addresses: string[]): Promise<ActorSnapshot> {
  const entries = await Promise.all(addresses.map(async (address) => [address, await accountInfo(algorand, address)] as const))
  return Object.fromEntries(entries)
}

/**
 * Assert each actor's balance and minimum-balance change, as `after - before`.
 *
 * @param before The snapshot taken before the operation.
 * @param after The snapshot taken after the operation.
 * @param expected Expected deltas keyed by address; omitted fields are unchecked.
 */
export function expectActorDeltas(before: ActorSnapshot, after: ActorSnapshot, expected: Record<string, Partial<AccountAmounts>>): void {
  for (const [address, delta] of Object.entries(expected)) {
    const beforeAmounts = before[address]
    const afterAmounts = after[address]
    if (beforeAmounts === undefined || afterAmounts === undefined) {
      throw new Error(`actor ${address} is missing from the snapshot`)
    }
    assertAccountDelta(address, beforeAmounts, afterAmounts, delta)
  }
}
