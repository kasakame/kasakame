import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliOptions } from './args.js'
import { openCliSession } from './session.js'

const mnemonicSessionMock = vi.hoisted(() => vi.fn())
const openWalletConnectionMock = vi.hoisted(() => vi.fn())

vi.mock('./mnemonic.js', () => ({ mnemonicSession: mnemonicSessionMock }))
vi.mock('./walletconnect.js', () => ({ openWalletConnection: openWalletConnectionMock }))

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
