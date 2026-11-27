import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliOptions } from '../app/options.js'
import { openCliSession, withSession } from './open-session.js'

const mnemonicSessionMock = vi.hoisted(() => vi.fn())
const openWalletConnectionMock = vi.hoisted(() => vi.fn())

vi.mock('./mnemonic/index.js', () => ({ mnemonicSession: mnemonicSessionMock }))
vi.mock('./wallet/index.js', () => ({ openWalletConnection: openWalletConnectionMock }))

const WALLET = { address: 'ADDRESS', signer: vi.fn() }

function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    command: 'refund',
    appId: 1n,
    network: 'testnet',
    signer: 'mnemonic',
    dryRun: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('openCliSession', () => {
  it('opens the mnemonic signer without a relay connection', async () => {
    mnemonicSessionMock.mockResolvedValue(WALLET)

    const session = await openCliSession(options({ mnemonicFile: '/tmp/mnemonic', address: 'ADDRESS' }))

    expect(mnemonicSessionMock).toHaveBeenCalledWith('/tmp/mnemonic', undefined, 'ADDRESS')
    expect(session.wallet).toBe(WALLET)
    await session.close()
    expect(openWalletConnectionMock).not.toHaveBeenCalled()
  })

  it('opens the WalletConnect session and exposes its close function', async () => {
    const close = vi.fn(async () => {})
    openWalletConnectionMock.mockResolvedValue({ info: {}, wallet: WALLET, close })

    const session = await openCliSession(options({ signer: 'wallet' }))

    expect(openWalletConnectionMock).toHaveBeenCalled()
    expect(session.wallet).toBe(WALLET)
    await session.close()
    expect(close).toHaveBeenCalled()
  })
})

describe('withSession', () => {
  it('runs the write and closes the session', async () => {
    mnemonicSessionMock.mockResolvedValue(WALLET)

    await expect(withSession(options(), (wallet) => Promise.resolve(wallet.address))).resolves.toBe('ADDRESS')
  })

  it('closes the session when the write fails', async () => {
    const close = vi.fn(async () => {})
    openWalletConnectionMock.mockResolvedValue({ info: {}, wallet: WALLET, close })

    await expect(
      withSession(options({ signer: 'wallet' }), () => {
        throw new Error('rejected')
      }),
    ).rejects.toThrow('rejected')
    expect(close).toHaveBeenCalled()
  })
})
