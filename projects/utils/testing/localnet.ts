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

/** An app's programs, global state, and update counter, comparable across calls. */
export interface AppSnapshot {
  approval: string
  clear: string
  version: string
  global: { key: string; bytes: string; uint: string }[]
}

/**
 * Snapshot an app's programs and global state.
 *
 * @param algorand The LocalNet client.
 * @param appId The app to snapshot.
 * @returns The comparable program/state snapshot.
 */
export async function appSnapshot(algorand: AlgorandClient, appId: bigint): Promise<AppSnapshot> {
  const { params } = await algorand.client.algod.getApplicationByID(appId).do()
  if (params === undefined) throw new Error(`app ${appId.toString()} has no params`)
  return {
    approval: Buffer.from(params.approvalProgram).toString('base64'),
    clear: Buffer.from(params.clearStateProgram).toString('base64'),
    version: (params.version ?? 0).toString(),
    global: (params.globalState ?? [])
      .map(({ key, value }) => ({
        key: Buffer.from(key).toString('base64'),
        bytes: Buffer.from(value.bytes).toString('base64'),
        uint: value.uint.toString(),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  }
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
