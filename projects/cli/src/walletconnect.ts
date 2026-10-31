import { KeyValueStorage } from '@walletconnect/keyvaluestorage'
import { SignClient } from '@walletconnect/sign-client'
import type { SessionTypes } from '@walletconnect/types'
import { isValidAddress } from 'algosdk'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import qrcode from 'qrcode-terminal'

// Public WalletConnect project ID; override with KASAKAME_WALLETCONNECT_PROJECT_ID.
export const DEFAULT_WALLETCONNECT_PROJECT_ID = '14c6183ad8c1cd4e6cd696352c64dc4e'
export const TESTNET_CHAIN_ID = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe'

const PROJECT_ID_PATTERN = /^[0-9a-f]{32}$/i
const DISCONNECT_REASON = { code: 6000, message: 'User disconnected' }
const METADATA = {
  name: 'kasakame CLI',
  description: 'Refund, cancel, and claim kasakame pledges',
  url: 'https://kasakame.com',
  icons: [],
}

export interface WalletConnectOptions {
  projectId?: string
  chainId?: string
  storagePath?: string
}

export interface WalletSessionInfo {
  address: string
  chainId: string
  expiry: number
  walletName: string
}

export interface LoginResult {
  session: WalletSessionInfo
  reused: boolean
}

/**
 * Validate a WalletConnect project ID.
 *
 * @param projectId Project ID from the Reown dashboard.
 * @returns The same project ID.
 */
export function validateProjectId(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error('WalletConnect project ID must be 32 hexadecimal characters')
  }
  return projectId
}

/**
 * Resolve the WalletConnect project ID from the environment or the embedded default.
 *
 * @param env Environment variables to read.
 * @returns The project ID.
 */
export function resolveProjectId(env: NodeJS.ProcessEnv = process.env): string {
  return validateProjectId(env.KASAKAME_WALLETCONNECT_PROJECT_ID?.trim() || DEFAULT_WALLETCONNECT_PROJECT_ID)
}

/**
 * Where the WalletConnect session for TestNet is stored.
 *
 * @returns Absolute database path.
 */
export function defaultSessionStoragePath(): string {
  return join(homedir(), '.kasakame', 'walletconnect', 'testnet')
}

/**
 * Pick the newest unexpired session for the given Algorand chain.
 *
 * @param sessions Sessions restored by SignClient.
 * @param chainId Algorand CAIP-2 chain id.
 * @param nowSeconds Current UNIX timestamp in seconds.
 * @returns The newest matching session, or undefined.
 */
export function selectSession(
  sessions: SessionTypes.Struct[],
  chainId: string = TESTNET_CHAIN_ID,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionTypes.Struct | undefined {
  return sessions
    .filter((session) => session.expiry > nowSeconds && (session.namespaces.algorand?.chains?.includes(chainId) ?? false))
    .sort((a, b) => b.expiry - a.expiry)[0]
}

/**
 * Map a WalletConnect session to the wallet details the CLI needs.
 *
 * @param session WalletConnect session.
 * @returns The address, chain, expiry, and wallet name.
 */
export function describeSession(session: SessionTypes.Struct): WalletSessionInfo {
  const namespace = session.namespaces.algorand
  const chainId = namespace?.chains?.[0]
  if (chainId === undefined) {
    throw new Error('Wallet session has no Algorand chain')
  }

  const address = namespace?.accounts[0]?.split(':').pop()
  if (address === undefined || !isValidAddress(address)) {
    throw new Error('Wallet session has no valid Algorand account')
  }

  return {
    address,
    chainId,
    expiry: session.expiry,
    walletName: session.peer.metadata.name,
  }
}

async function createClient(projectId: string, storagePath: string): Promise<InstanceType<typeof SignClient>> {
  validateProjectId(projectId)
  mkdirSync(storagePath, { recursive: true, mode: 0o700 })
  return SignClient.init({
    projectId,
    metadata: METADATA,
    storage: new KeyValueStorage({ database: storagePath }),
    logger: 'error',
  })
}

async function closeClient(client: InstanceType<typeof SignClient>): Promise<void> {
  try {
    await client.core.relayer.transportClose()
  } catch {
    // The session is already persisted; a failed transport close must not hide the result.
  }
}

function resolveOptions(options: WalletConnectOptions): { projectId: string; chainId: string; storagePath: string } {
  return {
    projectId: options.projectId ?? resolveProjectId(),
    chainId: options.chainId ?? TESTNET_CHAIN_ID,
    storagePath: options.storagePath ?? defaultSessionStoragePath(),
  }
}

/**
 * Pair a wallet over WalletConnect, reusing a valid stored session when present.
 *
 * @param options Overrides for the project ID, chain, and session storage.
 * @returns The connected session and whether it was reused.
 */
export async function login(options: WalletConnectOptions = {}): Promise<LoginResult> {
  const { projectId, chainId, storagePath } = resolveOptions(options)
  const client = await createClient(projectId, storagePath)
  try {
    const existing = selectSession(client.session.getAll(), chainId)
    if (existing !== undefined) {
      return { session: describeSession(existing), reused: true }
    }

    const { uri, approval } = await client.connect({
      optionalNamespaces: {
        algorand: { chains: [chainId], methods: ['algo_signTxn'], events: [] },
      },
    })
    if (uri === undefined) {
      throw new Error('WalletConnect did not return a pairing URI')
    }

    console.log('\nScan this QR code with Pera, Defly, or another Algorand WalletConnect wallet:\n')
    qrcode.generate(uri, { small: true })
    console.log(`\nOr copy this pairing URI:\n${uri}\n`)

    return { session: describeSession(await approval()), reused: false }
  } finally {
    await closeClient(client)
  }
}

/**
 * Read the stored wallet session for the chain.
 *
 * @param options Overrides for the project ID, chain, and session storage.
 * @returns The stored session, or undefined when none matches.
 */
export async function whoami(options: WalletConnectOptions = {}): Promise<WalletSessionInfo | undefined> {
  const { projectId, chainId, storagePath } = resolveOptions(options)
  const client = await createClient(projectId, storagePath)
  try {
    const session = selectSession(client.session.getAll(), chainId)
    return session === undefined ? undefined : describeSession(session)
  } finally {
    await closeClient(client)
  }
}

/**
 * Disconnect the stored wallet session.
 *
 * @param options Overrides for the project ID, chain, and session storage.
 * @returns True when a session was disconnected, false when there was none.
 */
export async function logout(options: WalletConnectOptions = {}): Promise<boolean> {
  const { projectId, chainId, storagePath } = resolveOptions(options)
  const client = await createClient(projectId, storagePath)
  try {
    const session = selectSession(client.session.getAll(), chainId)
    if (session === undefined) {
      return false
    }

    try {
      await client.disconnect({ topic: session.topic, reason: DISCONNECT_REASON })
    } catch {
      // Relay unreachable: still remove the local session so logout works offline.
      await client.session.delete(session.topic, DISCONNECT_REASON)
    }
    return true
  } finally {
    await closeClient(client)
  }
}
