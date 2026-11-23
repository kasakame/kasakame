import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'

/** An account's spendable balance and its minimum balance. */
export interface AccountAmounts {
  balance: bigint
  minBalance: bigint
}

/**
 * Read an account's balance and minimum balance.
 *
 * @param algorand The LocalNet client.
 * @param address The account address.
 * @returns The account amounts.
 */
export async function accountInfo(algorand: AlgorandClient, address: string): Promise<AccountAmounts> {
  const info = await algorand.account.getInformation(address)
  return { balance: info.balance.microAlgo, minBalance: info.minBalance.microAlgo }
}

/**
 * @param algorand The LocalNet client.
 * @param address The account address.
 * @returns Its spendable balance.
 */
export async function balanceOf(algorand: AlgorandClient, address: string): Promise<bigint> {
  return (await accountInfo(algorand, address)).balance
}

/**
 * @param algorand The LocalNet client.
 * @param address The account address.
 * @returns Its minimum balance.
 */
export async function minBalanceOf(algorand: AlgorandClient, address: string): Promise<bigint> {
  return (await accountInfo(algorand, address)).minBalance
}

/**
 * Advance the dev-mode chain clock by producing one self-payment, then reset the offset.
 *
 * @param fixture The Algorand fixture (for the funded test account).
 * @param seconds Seconds to jump forward.
 */
export async function advanceTime(fixture: AlgorandFixture, seconds: number): Promise<void> {
  const algorand = fixture.context.algorand
  const algod = algorand.client.algod
  try {
    await algod.setBlockOffsetTimestamp(seconds).do()
    await algorand.send.payment({
      sender: fixture.context.testAccount.addr,
      receiver: fixture.context.testAccount.addr,
      amount: microAlgos(1_000n),
      suppressLog: true,
    })
  } finally {
    await algod.setBlockOffsetTimestamp(0).do()
  }
}
