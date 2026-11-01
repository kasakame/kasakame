import { WalletConnect, type IClientMeta, type ISessionStorage, type IWalletConnectSession } from '@perawallet/walletconnect'
import type { Transaction, TransactionSigner } from 'algosdk'
import { isValidAddress } from 'algosdk'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import qrcode from 'qrcode-terminal'

// Pera and Defly both pair over WalletConnect v1 and read their bridge list from the same Pera servers.
const BRIDGE_CONFIG_URL = 'https://wc.perawallet.app/config.json'
const FALLBACK_BRIDGE = 'https://wallet-connect-a.perawallet.app'
const BRIDGE_TIMEOUT_MS = 10_000
const APPROVAL_TIMEOUT_MS = 5 * 60_000
const ALGORAND_CHAIN_ID = 4160
const METADATA: IClientMeta = {
  name: 'kasakame CLI',
  description: 'Refund, cancel, claim, and delete kasakame campaigns',
  url: 'https://kasakame.com',
  icons: [],
}

export interface WalletConnectOptions {
  bridge?: string
  storagePath?: string
}

export interface WalletSessionInfo {
  address: string
  walletName: string
}

export interface LoginResult {
  session: WalletSessionInfo
  reused: boolean
}

export interface WalletConnection {
  info: WalletSessionInfo
  wallet: { address: string; signer: TransactionSigner }
  close: () => Promise<void>
}

class FileSessionStorage implements ISessionStorage {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  }

  getSession(): IWalletConnectSession | null {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as IWalletConnectSession
    } catch {
      return null
    }
  }

  setSession(session: IWalletConnectSession): IWalletConnectSession {
    writeFileSync(this.file, `${JSON.stringify(session)}\n`, { mode: 0o600 })
    return session
  }

  removeSession(): void {
    rmSync(this.file, { force: true })
  }
}

/**
 * Where the WalletConnect v1 session for TestNet is stored.
 *
 * @returns Absolute session file path.
 */
export function defaultSessionStoragePath(): string {
  return join(homedir(), '.kasakame', 'walletconnect', 'testnet.json')
}

interface SessionView {
  accounts: string[]
  session: IWalletConnectSession
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

async function resolveBridge(options: WalletConnectOptions): Promise<string> {
  if (options.bridge !== undefined) return options.bridge
  try {
    const response = await withTimeout(fetch(BRIDGE_CONFIG_URL), BRIDGE_TIMEOUT_MS, 'Timed out reading the WalletConnect bridge list')
    const config = (await response.json()) as { servers?: string[] }
    const servers = config.servers ?? []
    const index = Math.floor(Math.random() * servers.length)
    return servers[index] ?? FALLBACK_BRIDGE
  } catch {
    return FALLBACK_BRIDGE
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

function createConnector(bridge: string, storagePath: string | undefined): InstanceType<typeof WalletConnect> {
  return new WalletConnect({
    bridge,
    storage: new FileSessionStorage(storagePath ?? defaultSessionStoragePath()),
    clientMeta: METADATA,
  })
}

function createSigner(client: InstanceType<typeof WalletConnect>, address: string): TransactionSigner {
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

/**
 * Open the stored wallet session as the SDK's `WalletSession`.
 *
 * @param options Overrides for the bridge and session storage.
 * @returns The session details, SDK wallet session, and a close function.
 */
export async function openWalletConnection(options: WalletConnectOptions = {}): Promise<WalletConnection> {
  const bridge = await resolveBridge(options)
  const client = createConnector(bridge, options.storagePath)
  if (!client.connected) {
    client.transportClose()
    throw new Error('No active wallet session. Run `kasakame login` first.')
  }

  const info = describeSession(client)
  return {
    info,
    wallet: { address: info.address, signer: createSigner(client, info.address) },
    close: () => {
      client.transportClose()
      return Promise.resolve()
    },
  }
}

/**
 * Pair a wallet over WalletConnect v1, reusing a valid stored session when present.
 *
 * @param options Overrides for the bridge and session storage.
 * @returns The connected session and whether it was reused.
 */
export async function login(options: WalletConnectOptions = {}): Promise<LoginResult> {
  const bridge = await resolveBridge(options)
  const client = createConnector(bridge, options.storagePath)
  try {
    if (client.connected) {
      return { session: describeSession(client), reused: true }
    }

    console.error('Connecting to the WalletConnect bridge…')
    await client.createSession({ chainId: ALGORAND_CHAIN_ID })
    // Pera and Defly recognize Algorand sessions from this query parameter (ARC-25).
    const uri = `${client.uri}&algorand=true`

    console.log('\nScan this QR code with Pera, Defly, or another Algorand wallet:\n')
    qrcode.generate(uri, { small: true })
    console.log(`\nOr copy this pairing URI:\n${uri}\n`)
    console.error('Waiting for your wallet to approve…')

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        client.on('connect', (error) => {
          if (error === null) {
            resolve()
          } else {
            reject(error)
          }
        })
        client.on('disconnect', () => {
          reject(new Error('The wallet disconnected. Run `kasakame login` again.'))
        })
      }),
      APPROVAL_TIMEOUT_MS,
      'Timed out waiting for the wallet. Run `kasakame login` again.',
    )

    return { session: describeSession(client), reused: false }
  } finally {
    client.transportClose()
  }
}

/**
 * Read the stored wallet session.
 *
 * @param options Overrides for the bridge and session storage.
 * @returns The stored session, or undefined when none is stored.
 */
export async function whoami(options: WalletConnectOptions = {}): Promise<WalletSessionInfo | undefined> {
  const bridge = await resolveBridge(options)
  const client = createConnector(bridge, options.storagePath)
  try {
    return client.connected ? describeSession(client) : undefined
  } finally {
    client.transportClose()
  }
}

/**
 * Disconnect the stored wallet session.
 *
 * @param options Overrides for the bridge and session storage.
 * @returns True when a session was disconnected, false when there was none.
 */
export async function logout(options: WalletConnectOptions = {}): Promise<boolean> {
  const bridge = await resolveBridge(options)
  const client = createConnector(bridge, options.storagePath)
  try {
    if (!client.connected) return false
    await client.killSession()
    return true
  } finally {
    client.transportClose()
  }
}
