import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { encodeAddress, getApplicationAddress, hexToBytes } from 'algosdk'
import { type Mock, vi } from 'vitest'
import { configureSdk } from '../../runtime/config.js'
import { clearTreeCache, u64be } from '../index.js'

function mock(): Mock {
  return vi.fn()
}

export const indexerMock = { searchForTransactions: mock(), lookupBlock: mock() }

export const CAMPAIGN = 42n
export const VAULT_ID = 7n
export const VAULT = getApplicationAddress(VAULT_ID).toString()
export const BACKER_A = encodeAddress(new Uint8Array(32).fill(1))
export const BACKER_B = encodeAddress(new Uint8Array(32).fill(2))

function fakeAlgorand(): AlgorandClient {
  return { client: { indexer: indexerMock } } as unknown as AlgorandClient
}

export const SELECTOR = {
  pledge: 'a4030bd2',
  cancel: '457e292e',
  refund: '4b1a1d96',
  claim: 'f1577726',
  vaultRefund: '0fe03dd2',
  credit: 'deadbeef',
} as const

/**
 * Minimal app-call fixture: only the fields the fetcher reads.
 *
 * @param txid Base32 transaction id.
 * @param sender Sender address.
 * @param round Confirmed round.
 * @param args Application args (selector first).
 * @returns The fixture transaction.
 */
export function appCall(txid: string, sender: string, round: bigint, args: Uint8Array[]): unknown {
  return { id: txid, sender, confirmedRound: round, applicationTransaction: { applicationId: 0n, applicationArgs: args } }
}

/**
 * Pledge app call fixture.
 *
 * @param txid Base32 transaction id.
 * @param sender Sender address.
 * @param round Confirmed round.
 * @returns The fixture transaction.
 */
export function pledgeCall(txid: string, sender: string, round: bigint): unknown {
  return appCall(txid, sender, round, [hexToBytes(SELECTOR.pledge), new Uint8Array()])
}

/**
 * Spend app call fixture.
 *
 * @param txid Base32 transaction id.
 * @param sender Sender address.
 * @param round Confirmed round.
 * @param selector Spend method selector.
 * @param k Nulled leaf position.
 * @returns The fixture transaction.
 */
export function spendCall(txid: string, sender: string, round: bigint, selector: string, k: bigint): unknown {
  return appCall(txid, sender, round, [hexToBytes(selector), u64be(k)])
}

/**
 * Vault refund app call fixture.
 *
 * @param txid Base32 transaction id.
 * @param sender Sender address.
 * @param round Confirmed round.
 * @param appId Refunded campaign app id.
 * @param k Nulled leaf position.
 * @returns The fixture transaction.
 */
export function vaultRefundCall(txid: string, sender: string, round: bigint, appId: bigint, k: bigint): unknown {
  return {
    id: txid,
    sender,
    confirmedRound: round,
    applicationTransaction: { applicationId: VAULT_ID, applicationArgs: [hexToBytes(SELECTOR.vaultRefund), u64be(appId), u64be(k)] },
  }
}

/**
 * Minimal payment fixture.
 *
 * @param txid Base32 transaction id.
 * @param sender Sender address.
 * @param receiver Receiver address.
 * @param amount Amount in microAlgos.
 * @returns The fixture transaction.
 */
export function payment(txid: string, sender: string, receiver: string, amount: bigint): unknown {
  return { id: txid, sender, paymentTransaction: { amount, receiver } }
}

/**
 * Paginated search mock keyed by application id.
 *
 * @param pagesByApp Result pages per application id.
 * @returns A `searchForTransactions` mock implementation.
 */
export function searchMock(pagesByApp: Map<bigint, unknown[][]>) {
  return () => {
    let appId = 0n
    let token: string | undefined
    const builder = {
      applicationID: (id: number | bigint) => {
        appId = BigInt(id)
        return builder
      },
      limit: () => builder,
      nextToken: (next: string) => {
        token = next
        return builder
      },
      do: () => {
        const pages = pagesByApp.get(appId) ?? [[]]
        const index = token === undefined ? 0 : Number(token)
        const transactions = pages[index] ?? []
        const nextToken = index + 1 < pages.length ? String(index + 1) : undefined
        return Promise.resolve({ transactions, nextToken, currentRound: 0n })
      },
    }
    return builder
  }
}

/**
 * Block lookup mock returning the fixture transactions for each round.
 *
 * @param blocks Transactions per round.
 * @returns A `lookupBlock` mock implementation.
 */
export function blockMock(blocks: Map<bigint, unknown[]>) {
  return (round: number | bigint) => ({
    do: () => Promise.resolve({ transactions: blocks.get(BigInt(round)) ?? [] }),
  })
}

/**
 * Reset mocks and point the SDK at a fake indexer for one test.
 */
export function setupIndexer(): void {
  vi.clearAllMocks()
  configureSdk({ algorand: fakeAlgorand(), registryAppId: CAMPAIGN, vaultAppId: VAULT_ID })
  clearTreeCache()
}
