import { WalletConnect, type IClientMeta, type IWalletConnectSession } from '@perawallet/walletconnect'
import type { Transaction, TransactionSigner } from 'algosdk'
import { isValidAddress } from 'algosdk'
import { FileSessionStorage, defaultSessionStoragePath } from './storage.js'
import type { WalletSessionInfo } from './types.js'

/** Algorand chain id used by WalletConnect v1. */
export const ALGORAND_CHAIN_ID = 4160

const METADATA: IClientMeta = {
  name: 'kasakame CLI',
  description: 'Refund, withdraw, claim, and delete kasakame pledges and campaigns',
  url: 'https://kasakame.com',
  icons: [],
}

interface SessionView {
  accounts: string[]
  session: IWalletConnectSession
}

/**
 * Reject a promise after a timeout.
 *
 * @param promise The promise to bound.
 * @param timeoutMs Timeout in milliseconds.
 * @param message Timeout error message.
 * @returns The promise result.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create a WalletConnect client with the CLI metadata and file-backed session.
 *
 * @param bridge The WalletConnect bridge URL.
 * @param storagePath Optional session file path.
 * @returns The WalletConnect client.
 */
export function createConnector(bridge: string, storagePath: string | undefined): InstanceType<typeof WalletConnect> {
  return new WalletConnect({
    bridge,
    storage: new FileSessionStorage(storagePath ?? defaultSessionStoragePath()),
    clientMeta: METADATA,
  })
}

/**
 * Map a paired client to the wallet details the CLI needs.
 *
 * @param client Connected WalletConnect client.
 * @returns The address and wallet name.
 */
export function describeSession(client: SessionView): WalletSessionInfo {
  const address = client.accounts[0]
  if (address === undefined || !isValidAddress(address)) {
    throw new Error('Wallet session has no valid Algorand account')
  }
  return { address, walletName: client.session.peerMeta?.name ?? 'WalletConnect wallet' }
}

/**
 * Create the transaction signer that forwards groups to the wallet.
 *
 * @param client Connected WalletConnect client.
 * @param address The signing account.
 * @returns The SDK transaction signer.
 */
export function createSigner(client: InstanceType<typeof WalletConnect>, address: string): TransactionSigner {
  return async (txnGroup: Transaction[], indexesToSign: number[]): Promise<Uint8Array[]> => {
    const toSign = new Set(indexesToSign)
    const walletTxns = txnGroup.map((txn, index) => {
      const encoded = Buffer.from(txn.toByte()).toString('base64')
      return toSign.has(index) && txn.sender.toString() === address ? { txn: encoded } : { txn: encoded, signers: [] }
    })

    const result: unknown = await client.sendCustomRequest({ method: 'algo_signTxn', params: [walletTxns] })
    const returned = (Array.isArray(result) ? result : [result]) as unknown[]
    const signed = returned
      .filter((value) => value !== null)
      .map((value) => {
        if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'base64'))
        return Uint8Array.from(value as number[])
      })
    if (signed.length !== toSign.size) {
      throw new Error(`Wallet returned ${String(signed.length)} signatures for ${String(toSign.size)} transactions`)
    }
    return signed
  }
}
