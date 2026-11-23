import assert from 'node:assert/strict'

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
