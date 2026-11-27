import assert from 'node:assert/strict'
import type { AccountAmounts } from './localnet.js'

/**
 * Assert a balance reading, naming the account or application in the failure.
 *
 * @param label What was read (normally an address).
 * @param actual The observed amount.
 * @param expected The expected amount.
 */
export function assertBalance(label: string, actual: bigint, expected: bigint): void {
  assert.equal(actual, expected, `${label} balance: expected ${expected.toString()}, got ${actual.toString()}`)
}

/**
 * Assert an account's balance and minimum-balance change, as `after - before`.
 *
 * @param label The account or application under test.
 * @param before The amounts read before the operation.
 * @param after The amounts read after the operation.
 * @param expected The expected deltas; omit a field to leave it unchecked.
 */
export function assertAccountDelta(label: string, before: AccountAmounts, after: AccountAmounts, expected: Partial<AccountAmounts>): void {
  if (expected.balance !== undefined) {
    assert.equal(
      after.balance - before.balance,
      expected.balance,
      `${label} balance delta: expected ${expected.balance.toString()}, got ${(after.balance - before.balance).toString()}`,
    )
  }
  if (expected.minBalance !== undefined) {
    assert.equal(
      after.minBalance - before.minBalance,
      expected.minBalance,
      `${label} min balance delta: expected ${expected.minBalance.toString()}, got ${(after.minBalance - before.minBalance).toString()}`,
    )
  }
}

/**
 * Assert that an action rejects and leaves a snapshot unchanged.
 *
 * @param action The call expected to fail.
 * @param snapshot Reads the state that must not change.
 * @param error Optional pattern or validator the rejection must satisfy.
 */
export async function assertRejectedUnchanged<T>(
  action: () => Promise<unknown>,
  snapshot: () => Promise<T>,
  error?: RegExp | ((error: unknown) => boolean),
): Promise<void> {
  const before = await snapshot()
  if (error === undefined) await assert.rejects(action)
  else await assert.rejects(action, error)
  assert.deepEqual(await snapshot(), before)
}
