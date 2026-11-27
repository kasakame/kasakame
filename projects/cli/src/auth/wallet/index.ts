import qrcode from 'qrcode-terminal'
import { resolveBridge } from './bridge.js'
import { ALGORAND_CHAIN_ID, createConnector, createSigner, describeSession, withTimeout } from './client.js'
import type { LoginResult, WalletConnectOptions, WalletConnection, WalletSessionInfo } from './types.js'

const APPROVAL_TIMEOUT_MS = 5 * 60_000

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
