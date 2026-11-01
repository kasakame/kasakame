import type { SessionTypes } from '@walletconnect/types'
import {
  generateAccount,
  makeBasicAccountTransactionSigner,
  makePaymentTxnWithSuggestedParamsFromObject,
  signTransactionWithSigner,
  type Transaction,
} from 'algosdk'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WALLETCONNECT_PROJECT_ID,
  TESTNET_CHAIN_ID,
  defaultSessionStoragePath,
  describeSession,
  login,
  logout,
  openWalletConnection,
  resolveProjectId,
  selectSession,
  validateProjectId,
  whoami,
} from './walletconnect.js'

const signClientInit = vi.hoisted(() => vi.fn())
const keyValueStorage = vi.hoisted(() => vi.fn())
const qrGenerate = vi.hoisted(() => vi.fn())

vi.mock('@walletconnect/sign-client', () => ({
  SignClient: { init: signClientInit },
}))
vi.mock('@walletconnect/keyvaluestorage', () => ({
  KeyValueStorage: keyValueStorage,
}))
vi.mock('qrcode-terminal', () => ({
  default: { generate: qrGenerate },
}))

const ACCOUNT = generateAccount()
const OTHER_ACCOUNT = generateAccount()
const ADDRESS = ACCOUNT.addr.toString()
const OTHER_ADDRESS = OTHER_ACCOUNT.addr.toString()
const METADATA = {
  name: 'Pera Wallet',
  description: 'Pera Wallet',
  url: 'https://perawallet.app',
  icons: [],
}

function makeSession(overrides: Partial<SessionTypes.Struct> = {}): SessionTypes.Struct {
  return {
    topic: 'topic-1',
    pairingTopic: 'pairing-1',
    relay: { protocol: 'irn' },
    expiry: 2_000_000_000,
    acknowledged: true,
    controller: 'controller',
    namespaces: {
      algorand: {
        chains: [TESTNET_CHAIN_ID],
        accounts: [`${TESTNET_CHAIN_ID}:${ADDRESS}`],
        methods: ['algo_signTxn'],
        events: [],
      },
    },
    requiredNamespaces: {},
    optionalNamespaces: {},
    self: { publicKey: 'self', metadata: METADATA },
    peer: { publicKey: 'peer', metadata: METADATA },
    ...overrides,
  }
}

function fakeClient(sessions: SessionTypes.Struct[] = []) {
  return {
    session: {
      getAll: vi.fn(() => sessions),
      delete: vi.fn(async () => {}),
    },
    connect: vi.fn(),
    disconnect: vi.fn(async () => {}),
    request: vi.fn(),
    core: { relayer: { transportClose: vi.fn(async () => {}) } },
  }
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

beforeEach(() => {
  vi.clearAllMocks()
  keyValueStorage.mockImplementation(function KeyValueStorageMock() {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('validateProjectId', () => {
  it('accepts a 32-character hex id', () => {
    expect(validateProjectId('14c6183ad8c1cd4e6cd696352c64dc4e')).toBe('14c6183ad8c1cd4e6cd696352c64dc4e')
  })

  it('rejects anything else', () => {
    expect(() => validateProjectId('not-a-project-id')).toThrow('32 hexadecimal characters')
  })
})

describe('resolveProjectId', () => {
  it('falls back to the embedded id', () => {
    expect(resolveProjectId({})).toBe(DEFAULT_WALLETCONNECT_PROJECT_ID)
  })

  it('reads the environment override', () => {
    expect(resolveProjectId({ KASAKAME_WALLETCONNECT_PROJECT_ID: 'a'.repeat(32) })).toBe('a'.repeat(32))
  })

  it('treats a blank override as missing', () => {
    expect(resolveProjectId({ KASAKAME_WALLETCONNECT_PROJECT_ID: '   ' })).toBe(DEFAULT_WALLETCONNECT_PROJECT_ID)
  })
})

describe('defaultSessionStoragePath', () => {
  it('keeps TestNet sessions under the kasakame home', () => {
    expect(defaultSessionStoragePath()).toContain(join('.kasakame', 'walletconnect', 'testnet'))
  })
})

describe('selectSession', () => {
  it('returns the newest unexpired session for the chain', () => {
    const older = makeSession({ topic: 'older', expiry: 100 })
    const newer = makeSession({ topic: 'newer', expiry: 200 })

    expect(selectSession([older, newer], TESTNET_CHAIN_ID, 50)?.topic).toBe('newer')
  })

  it('ignores expired sessions', () => {
    expect(selectSession([makeSession({ expiry: 10 })], TESTNET_CHAIN_ID, 20)).toBeUndefined()
  })

  it('ignores other chains', () => {
    const session = makeSession({
      namespaces: {
        algorand: {
          chains: ['algorand:other'],
          accounts: ['algorand:other:ADDRESS'],
          methods: ['algo_signTxn'],
          events: [],
        },
      },
    })

    expect(selectSession([session], TESTNET_CHAIN_ID, 1)).toBeUndefined()
  })

  it('ignores a namespace without chains', () => {
    const session = makeSession({
      namespaces: {
        algorand: { accounts: [], methods: ['algo_signTxn'], events: [] },
      },
    })

    expect(selectSession([session], TESTNET_CHAIN_ID, 1)).toBeUndefined()
  })

  it('returns undefined with no sessions', () => {
    expect(selectSession([], TESTNET_CHAIN_ID, 1)).toBeUndefined()
  })
})

describe('describeSession', () => {
  it('maps the session details', () => {
    expect(describeSession(makeSession())).toEqual({
      address: ADDRESS,
      chainId: TESTNET_CHAIN_ID,
      expiry: 2_000_000_000,
      walletName: 'Pera Wallet',
    })
  })

  it('rejects a session without an Algorand chain', () => {
    expect(() => describeSession(makeSession({ namespaces: {} }))).toThrow('no Algorand chain')
  })

  it('rejects a session without accounts', () => {
    const session = makeSession({
      namespaces: {
        algorand: { chains: [TESTNET_CHAIN_ID], accounts: [], methods: ['algo_signTxn'], events: [] },
      },
    })

    expect(() => describeSession(session)).toThrow('no valid Algorand account')
  })

  it('rejects an invalid account address', () => {
    const session = makeSession({
      namespaces: {
        algorand: {
          chains: [TESTNET_CHAIN_ID],
          accounts: [`${TESTNET_CHAIN_ID}:not-an-address`],
          methods: ['algo_signTxn'],
          events: [],
        },
      },
    })

    expect(() => describeSession(session)).toThrow('no valid Algorand account')
  })
})

describe('login', () => {
  it('reuses a valid stored session', async () => {
    const client = fakeClient([makeSession()])
    signClientInit.mockResolvedValue(client)

    const result = await login({ storagePath: '/tmp/opencode/kasakame-cli-test' })

    expect(result.reused).toBe(true)
    expect(result.session.address).toBe(ADDRESS)
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.core.relayer.transportClose).toHaveBeenCalled()
  })

  it('pairs a new session and prints the QR', async () => {
    const client = fakeClient()
    client.connect.mockResolvedValue({
      uri: 'wc:test-uri',
      approval: () => Promise.resolve(makeSession({ topic: 'new-topic' })),
    })
    signClientInit.mockResolvedValue(client)

    const result = await login({
      projectId: 'a'.repeat(32),
      chainId: TESTNET_CHAIN_ID,
      storagePath: '/tmp/opencode/kasakame-cli-test',
    })

    expect(result.reused).toBe(false)
    expect(client.connect).toHaveBeenCalledWith({
      optionalNamespaces: {
        algorand: { chains: [TESTNET_CHAIN_ID], methods: ['algo_signTxn'], events: [] },
      },
    })
    expect(console.error).toHaveBeenCalledWith('Connecting to the WalletConnect relay…')
    expect(console.error).toHaveBeenCalledWith('Waiting for your wallet to approve…')
    expect(qrGenerate).toHaveBeenCalledWith('wc:test-uri', { small: true })
    expect(client.core.relayer.transportClose).toHaveBeenCalled()
  })

  it('times out waiting for the wallet approval', async () => {
    vi.useFakeTimers()
    try {
      const client = fakeClient()
      client.connect.mockResolvedValue({ uri: 'wc:test-uri', approval: () => new Promise(() => {}) })
      signClientInit.mockResolvedValue(client)

      const pending = login({ storagePath: '/tmp/opencode/kasakame-cli-test' })
      const assertion = expect(pending).rejects.toThrow('Timed out waiting for the wallet')
      await vi.advanceTimersByTimeAsync(5 * 60_000)

      await assertion
      expect(client.core.relayer.transportClose).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails when WalletConnect returns no pairing URI', async () => {
    const client = fakeClient()
    client.connect.mockResolvedValue({ approval: () => Promise.resolve(makeSession()) })
    signClientInit.mockResolvedValue(client)

    await expect(login({ storagePath: '/tmp/opencode/kasakame-cli-test' })).rejects.toThrow('did not return a pairing URI')
    expect(client.core.relayer.transportClose).toHaveBeenCalled()
  })

  it('uses the embedded project id and default storage path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kasakame-cli-'))
    vi.stubEnv('HOME', home)
    const client = fakeClient([makeSession()])
    signClientInit.mockResolvedValue(client)

    try {
      const result = await login()

      expect(result.reused).toBe(true)
      expect(signClientInit).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: DEFAULT_WALLETCONNECT_PROJECT_ID,
          storage: expect.anything(),
        }),
      )
      expect(defaultSessionStoragePath()).toBe(join(home, '.kasakame', 'walletconnect', 'testnet'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects an invalid project id', async () => {
    await expect(login({ projectId: 'invalid', storagePath: '/tmp/opencode/kasakame-cli-test' })).rejects.toThrow(
      '32 hexadecimal characters',
    )
  })

  it('keeps the result when closing the transport fails', async () => {
    const client = fakeClient([makeSession()])
    client.core.relayer.transportClose.mockRejectedValue(new Error('close failed'))
    signClientInit.mockResolvedValue(client)

    const result = await login({ storagePath: '/tmp/opencode/kasakame-cli-test' })

    expect(result.reused).toBe(true)
  })
})

describe('whoami', () => {
  it('returns the stored session', async () => {
    const client = fakeClient([makeSession()])
    signClientInit.mockResolvedValue(client)

    expect(await whoami({ storagePath: '/tmp/opencode/kasakame-cli-test' })).toMatchObject({ address: ADDRESS })
    expect(client.core.relayer.transportClose).toHaveBeenCalled()
  })

  it('returns undefined without a session', async () => {
    const client = fakeClient()
    signClientInit.mockResolvedValue(client)

    expect(await whoami({ chainId: 'algorand:other', storagePath: '/tmp/opencode/kasakame-cli-test' })).toBeUndefined()
    expect(client.core.relayer.transportClose).toHaveBeenCalled()
  })
})

describe('logout', () => {
  it('disconnects the stored session', async () => {
    const session = makeSession()
    const client = fakeClient([session])
    signClientInit.mockResolvedValue(client)

    expect(await logout({ storagePath: '/tmp/opencode/kasakame-cli-test' })).toBe(true)
    expect(client.disconnect).toHaveBeenCalledWith({ topic: session.topic, reason: { code: 6000, message: 'User disconnected' } })
    expect(client.core.relayer.transportClose).toHaveBeenCalled()
  })

  it('returns false without a session', async () => {
    const client = fakeClient()
    signClientInit.mockResolvedValue(client)

    expect(await logout({ storagePath: '/tmp/opencode/kasakame-cli-test' })).toBe(false)
    expect(client.disconnect).not.toHaveBeenCalled()
  })

  it('removes the local session when the relay is unreachable', async () => {
    const session = makeSession()
    const client = fakeClient([session])
    client.disconnect.mockRejectedValue(new Error('relay down'))
    signClientInit.mockResolvedValue(client)

    expect(await logout({ storagePath: '/tmp/opencode/kasakame-cli-test' })).toBe(true)
    expect(client.session.delete).toHaveBeenCalledWith(session.topic, { code: 6000, message: 'User disconnected' })
  })
})

describe('openWalletConnection', () => {
  it('fails without a session and closes the client', async () => {
    const client = fakeClient()
    signClientInit.mockResolvedValue(client)

    await expect(openWalletConnection({ storagePath: '/tmp/opencode/kasakame-cli-test' })).rejects.toThrow('No active wallet session')
    expect(client.core.relayer.transportClose).toHaveBeenCalled()
  })

  it('returns a signer that sends algo_signTxn', async () => {
    const client = fakeClient([makeSession()])
    const txn = makeTxn()
    const otherTxn = makeTxn(OTHER_ADDRESS)
    const signed = (await signTransactionWithSigner(txn, makeBasicAccountTransactionSigner(ACCOUNT))).blob
    client.request.mockResolvedValue([Buffer.from(signed).toString('base64'), null])
    signClientInit.mockResolvedValue(client)

    const connection = await openWalletConnection({ storagePath: '/tmp/opencode/kasakame-cli-test' })

    expect(connection.info.address).toBe(ADDRESS)
    expect(connection.wallet.address).toBe(ADDRESS)
    await expect(connection.wallet.signer([txn, otherTxn], [0])).resolves.toEqual([signed])
    expect(client.request).toHaveBeenCalledWith({
      topic: 'topic-1',
      chainId: TESTNET_CHAIN_ID,
      request: {
        method: 'algo_signTxn',
        params: [
          [{ txn: Buffer.from(txn.toByte()).toString('base64') }, { txn: Buffer.from(otherTxn.toByte()).toString('base64'), signers: [] }],
        ],
      },
    })

    await connection.close()
    expect(client.core.relayer.transportClose).toHaveBeenCalled()
  })

  it('propagates a wallet rejection', async () => {
    const client = fakeClient([makeSession()])
    client.request.mockRejectedValue(new Error('Request rejected by user'))
    signClientInit.mockResolvedValue(client)

    const connection = await openWalletConnection({ storagePath: '/tmp/opencode/kasakame-cli-test' })

    await expect(connection.wallet.signer([makeTxn()], [0])).rejects.toThrow('Request rejected by user')
  })

  it('fails when the wallet returns no signatures', async () => {
    const client = fakeClient([makeSession()])
    client.request.mockResolvedValue([null])
    signClientInit.mockResolvedValue(client)

    const connection = await openWalletConnection({ storagePath: '/tmp/opencode/kasakame-cli-test' })

    await expect(connection.wallet.signer([makeTxn()], [0])).rejects.toThrow('returned 0 signatures for 1 transactions')
  })

  it('does not sign transactions from another sender', async () => {
    const client = fakeClient([makeSession()])
    client.request.mockResolvedValue([null])
    signClientInit.mockResolvedValue(client)

    const connection = await openWalletConnection({ storagePath: '/tmp/opencode/kasakame-cli-test' })

    await expect(connection.wallet.signer([makeTxn(OTHER_ADDRESS)], [0])).rejects.toThrow('returned 0 signatures for 1 transactions')
  })
})
