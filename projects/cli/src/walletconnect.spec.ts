import type { ISessionStorage, IWalletConnectSession } from '@perawallet/walletconnect'
import {
  generateAccount,
  makeBasicAccountTransactionSigner,
  makePaymentTxnWithSuggestedParamsFromObject,
  signTransactionWithSigner,
  type Transaction,
} from 'algosdk'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSessionStoragePath, describeSession, login, logout, openWalletConnection, whoami } from './walletconnect.js'

const walletConnectCtor = vi.hoisted(() => vi.fn())
const qrGenerate = vi.hoisted(() => vi.fn())

vi.mock('@perawallet/walletconnect', () => ({ WalletConnect: walletConnectCtor }))
vi.mock('qrcode-terminal', () => ({ default: { generate: qrGenerate } }))

const ACCOUNT = generateAccount()
const OTHER_ACCOUNT = generateAccount()
const ADDRESS = ACCOUNT.addr.toString()
const OTHER_ADDRESS = OTHER_ACCOUNT.addr.toString()

interface FakeClient {
  connected: boolean
  accounts: string[]
  session: IWalletConnectSession
  uri: string
  chainId: number
  storage: ISessionStorage
  createSession: ReturnType<typeof vi.fn>
  killSession: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  sendCustomRequest: ReturnType<typeof vi.fn>
  transportClose: ReturnType<typeof vi.fn>
  emit: (event: string, error: Error | null, payload?: unknown) => void
}

const created: FakeClient[] = []

function makeSession(overrides: Partial<IWalletConnectSession> = {}): IWalletConnectSession {
  return {
    connected: true,
    accounts: [ADDRESS],
    chainId: 4160,
    bridge: 'https://wallet-connect-a.perawallet.app',
    key: 'key',
    clientId: 'client',
    clientMeta: { name: 'kasakame CLI', description: 'CLI', url: 'https://kasakame.com', icons: [] },
    peerId: 'peer',
    peerMeta: { name: 'Pera Wallet', description: 'Pera Wallet', url: 'https://perawallet.app', icons: [] },
    handshakeId: 1,
    handshakeTopic: 'topic-1',
    ...overrides,
  }
}

function makeClient(storage: ISessionStorage): FakeClient {
  const stored = storage.getSession()
  const listeners = new Map<string, (error: Error | null, payload: unknown) => void>()
  const client: FakeClient = {
    connected: stored !== null,
    accounts: stored?.accounts ?? [],
    session: stored ?? makeSession({ connected: false, accounts: [] }),
    uri: 'wc:test-uri',
    chainId: 4160,
    storage,
    createSession: vi.fn(() => Promise.resolve()),
    killSession: vi.fn(() => {
      storage.removeSession()
      return Promise.resolve()
    }),
    on: vi.fn((event: string, callback: (error: Error | null, payload: unknown) => void) => {
      listeners.set(event, callback)
    }),
    sendCustomRequest: vi.fn(),
    transportClose: vi.fn(),
    emit: (event, error, payload = null) => {
      if (event === 'connect' && error === null) {
        const session = makeSession()
        storage.setSession(session)
        client.accounts = session.accounts
        client.session = session
      }
      listeners.get(event)?.(error, payload)
    },
  }
  created.push(client)
  return client
}

function lastClient(): FakeClient {
  const client = created[created.length - 1]
  if (client === undefined) throw new Error('no client was created')
  return client
}
function makeTxn(sender: string = ADDRESS): Transaction {
  return makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: ADDRESS,
    amount: 0,
    suggestedParams: {
      fee: 0,
      minFee: 1000,
      flatFee: true,
      firstValid: 1,
      lastValid: 1000,
      genesisHash: new Uint8Array(32),
      genesisID: 'testnet-v1.0',
    },
  })
}

function stubBridgeConfig(servers: string[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ servers }) })),
  )
}

let workDir: string
let sessionPath: string

beforeEach(() => {
  vi.clearAllMocks()
  created.length = 0
  walletConnectCtor.mockImplementation(function MockWalletConnect(options: { storage: ISessionStorage }) {
    return makeClient(options.storage)
  })
  workDir = mkdtempSync(join(tmpdir(), 'kasakame-cli-'))
  sessionPath = join(workDir, 'testnet.json')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(workDir, { recursive: true, force: true })
})

describe('defaultSessionStoragePath', () => {
  it('keeps the TestNet session under the kasakame home', () => {
    expect(defaultSessionStoragePath()).toContain(join('.kasakame', 'walletconnect', 'testnet.json'))
  })
})

describe('describeSession', () => {
  it('maps the stored session details', () => {
    expect(describeSession(makeClient({ getSession: () => makeSession(), setSession: (s) => s, removeSession: () => {} }))).toEqual({
      address: ADDRESS,
      walletName: 'Pera Wallet',
    })
  })

  it('falls back to a generic wallet name', () => {
    const session = makeSession({ peerMeta: null })
    const client = makeClient({ getSession: () => session, setSession: (s) => s, removeSession: () => {} })

    expect(describeSession(client).walletName).toBe('WalletConnect wallet')
  })

  it('rejects a session without accounts', () => {
    const client = makeClient({
      getSession: () => makeSession({ accounts: [] }),
      setSession: (s) => s,
      removeSession: () => {},
    })

    expect(() => describeSession(client)).toThrow('no valid Algorand account')
  })

  it('rejects an invalid account address', () => {
    const client = makeClient({
      getSession: () => makeSession({ accounts: ['not-an-address'] }),
      setSession: (s) => s,
      removeSession: () => {},
    })

    expect(() => describeSession(client)).toThrow('no valid Algorand account')
  })
})

describe('login', () => {
  it('reuses a stored session', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession()))

    const result = await login({ bridge: 'https://bridge', storagePath: sessionPath })

    expect(result.reused).toBe(true)
    expect(result.session.address).toBe(ADDRESS)
    expect(lastClient().createSession).not.toHaveBeenCalled()
    expect(lastClient().transportClose).toHaveBeenCalled()
  })

  it('pairs a new session and prints the QR with algorand=true', async () => {
    const pending = login({ bridge: 'https://bridge', storagePath: sessionPath })
    await vi.waitFor(() => {
      expect(lastClient().on).toHaveBeenCalled()
    })

    const client = lastClient()
    client.emit('connect', null, { params: [{ accounts: [ADDRESS] }] })
    const result = await pending

    expect(result.reused).toBe(false)
    expect(client.createSession).toHaveBeenCalledWith({ chainId: 4160 })
    expect(console.error).toHaveBeenCalledWith('Connecting to the WalletConnect bridge…')
    expect(console.error).toHaveBeenCalledWith('Waiting for your wallet to approve…')
    expect(qrGenerate).toHaveBeenCalledWith('wc:test-uri&algorand=true', { small: true })
    expect(client.transportClose).toHaveBeenCalled()
  })

  it('propagates a wallet rejection', async () => {
    const pending = login({ bridge: 'https://bridge', storagePath: sessionPath })
    const assertion = expect(pending).rejects.toThrow('User rejected the pairing')
    await vi.waitFor(() => {
      expect(lastClient().on).toHaveBeenCalled()
    })
    lastClient().emit('connect', new Error('User rejected the pairing'))

    await assertion
    expect(lastClient().transportClose).toHaveBeenCalled()
  })

  it('stops when the wallet disconnects during pairing', async () => {
    const pending = login({ bridge: 'https://bridge', storagePath: sessionPath })
    const assertion = expect(pending).rejects.toThrow('The wallet disconnected')
    await vi.waitFor(() => {
      expect(lastClient().on).toHaveBeenCalled()
    })
    lastClient().emit('disconnect', null)

    await assertion
  })

  it('times out waiting for the wallet approval', async () => {
    vi.useFakeTimers()
    try {
      const pending = login({ bridge: 'https://bridge', storagePath: sessionPath })
      const assertion = expect(pending).rejects.toThrow('Timed out waiting for the wallet')
      await vi.advanceTimersByTimeAsync(5 * 60_000)

      await assertion
      expect(lastClient().transportClose).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses a bridge from the Pera config and the default storage path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kasakame-home-'))
    vi.stubEnv('HOME', home)
    stubBridgeConfig(['https://bridge-a', 'https://bridge-b'])
    const defaultSessionFile = join(home, '.kasakame', 'walletconnect', 'testnet.json')
    mkdirSync(dirname(defaultSessionFile), { recursive: true })
    writeFileSync(defaultSessionFile, JSON.stringify(makeSession()))

    try {
      const result = await login()

      expect(result.reused).toBe(true)
      expect(walletConnectCtor).toHaveBeenCalledWith(expect.objectContaining({ bridge: expect.stringMatching(/^https:\/\/bridge-/) }))
      expect(defaultSessionStoragePath()).toBe(defaultSessionFile)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('falls back to the known bridge when the config is unreachable', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession()))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    )

    await login({ storagePath: sessionPath })

    expect(walletConnectCtor).toHaveBeenCalledWith(expect.objectContaining({ bridge: 'https://wallet-connect-a.perawallet.app' }))
  })

  it('falls back when the config lists no bridges', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession()))
    stubBridgeConfig([])

    await login({ storagePath: sessionPath })

    expect(walletConnectCtor).toHaveBeenCalledWith(expect.objectContaining({ bridge: 'https://wallet-connect-a.perawallet.app' }))
  })

  it('falls back when the config omits the bridge list', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession()))
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })),
    )

    await login({ storagePath: sessionPath })

    expect(walletConnectCtor).toHaveBeenCalledWith(expect.objectContaining({ bridge: 'https://wallet-connect-a.perawallet.app' }))
  })
})

describe('whoami', () => {
  it('returns the stored session', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession()))

    expect(await whoami({ bridge: 'https://bridge', storagePath: sessionPath })).toEqual({
      address: ADDRESS,
      walletName: 'Pera Wallet',
    })
    expect(lastClient().transportClose).toHaveBeenCalled()
  })

  it('returns undefined without a session', async () => {
    expect(await whoami({ bridge: 'https://bridge', storagePath: sessionPath })).toBeUndefined()
    expect(lastClient().transportClose).toHaveBeenCalled()
  })

  it('treats a corrupt session file as empty', async () => {
    writeFileSync(sessionPath, 'not json')

    expect(await whoami({ bridge: 'https://bridge', storagePath: sessionPath })).toBeUndefined()
  })
})

describe('logout', () => {
  it('disconnects the stored session and removes it', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession()))

    expect(await logout({ bridge: 'https://bridge', storagePath: sessionPath })).toBe(true)
    expect(lastClient().killSession).toHaveBeenCalled()
    expect(lastClient().transportClose).toHaveBeenCalled()
    expect(await whoami({ bridge: 'https://bridge', storagePath: sessionPath })).toBeUndefined()
  })

  it('returns false without a session', async () => {
    expect(await logout({ bridge: 'https://bridge', storagePath: sessionPath })).toBe(false)
    expect(lastClient().killSession).not.toHaveBeenCalled()
  })

  it('propagates a failed disconnect', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession()))
    walletConnectCtor.mockImplementationOnce(function MockFailingWalletConnect(options: { storage: ISessionStorage }) {
      const client = makeClient(options.storage)
      client.killSession.mockRejectedValue(new Error('bridge down'))
      return client
    })

    await expect(logout({ bridge: 'https://bridge', storagePath: sessionPath })).rejects.toThrow('bridge down')
  })
})

describe('openWalletConnection', () => {
  it('fails without a session and closes the client', async () => {
    await expect(openWalletConnection({ bridge: 'https://bridge', storagePath: sessionPath })).rejects.toThrow('No active wallet session')
    expect(lastClient().transportClose).toHaveBeenCalled()
  })

  it('returns a signer that sends algo_signTxn', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession()))
    const txn = makeTxn()
    const otherTxn = makeTxn(OTHER_ADDRESS)
    const signed = (await signTransactionWithSigner(txn, makeBasicAccountTransactionSigner(ACCOUNT))).blob
    const connection = await openWalletConnection({ bridge: 'https://bridge', storagePath: sessionPath })
    const client = lastClient()
    client.sendCustomRequest.mockResolvedValue([Buffer.from(signed).toString('base64'), null])

    expect(connection.info.address).toBe(ADDRESS)
    expect(connection.wallet.address).toBe(ADDRESS)
    await expect(connection.wallet.signer([txn, otherTxn], [0])).resolves.toEqual([signed])
    expect(client.sendCustomRequest).toHaveBeenCalledWith({
      method: 'algo_signTxn',
      params: [
        [{ txn: Buffer.from(txn.toByte()).toString('base64') }, { txn: Buffer.from(otherTxn.toByte()).toString('base64'), signers: [] }],
      ],
    })

    await connection.close()
    expect(client.transportClose).toHaveBeenCalled()
  })

  it('accepts byte-array signatures', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession()))
    const txn = makeTxn()
    const signed = (await signTransactionWithSigner(txn, makeBasicAccountTransactionSigner(ACCOUNT))).blob
    const connection = await openWalletConnection({ bridge: 'https://bridge', storagePath: sessionPath })
    lastClient().sendCustomRequest.mockResolvedValue([Array.from(signed)])

    await expect(connection.wallet.signer([txn], [0])).resolves.toEqual([signed])
  })

  it('accepts a single signature response', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession()))
    const txn = makeTxn()
    const signed = (await signTransactionWithSigner(txn, makeBasicAccountTransactionSigner(ACCOUNT))).blob
    const connection = await openWalletConnection({ bridge: 'https://bridge', storagePath: sessionPath })
    lastClient().sendCustomRequest.mockResolvedValue(Buffer.from(signed).toString('base64'))

    await expect(connection.wallet.signer([txn], [0])).resolves.toEqual([signed])
  })

  it('propagates a wallet rejection', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession()))
    const connection = await openWalletConnection({ bridge: 'https://bridge', storagePath: sessionPath })
    lastClient().sendCustomRequest.mockRejectedValue(new Error('Request rejected by user'))

    await expect(connection.wallet.signer([makeTxn()], [0])).rejects.toThrow('Request rejected by user')
  })

  it('fails when the wallet returns no signatures', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession()))
    const connection = await openWalletConnection({ bridge: 'https://bridge', storagePath: sessionPath })
    lastClient().sendCustomRequest.mockResolvedValue([null])

    await expect(connection.wallet.signer([makeTxn()], [0])).rejects.toThrow('returned 0 signatures for 1 transactions')
  })

  it('does not sign transactions from another sender', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession()))
    const connection = await openWalletConnection({ bridge: 'https://bridge', storagePath: sessionPath })
    lastClient().sendCustomRequest.mockResolvedValue([null])

    await expect(connection.wallet.signer([makeTxn(OTHER_ADDRESS)], [0])).rejects.toThrow('returned 0 signatures for 1 transactions')
  })
})
