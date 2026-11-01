import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from './cli.js'

const loginMock = vi.hoisted(() => vi.fn())
const whoamiMock = vi.hoisted(() => vi.fn())
const logoutMock = vi.hoisted(() => vi.fn())
const mnemonicSessionMock = vi.hoisted(() => vi.fn())
const configureCliChainMock = vi.hoisted(() => vi.fn())
const runRefundMock = vi.hoisted(() => vi.fn())
const runCancelMock = vi.hoisted(() => vi.fn())
const runClaimMock = vi.hoisted(() => vi.fn())
const runDeleteMock = vi.hoisted(() => vi.fn())
const runPledgesMock = vi.hoisted(() => vi.fn())
const runCampaignsMock = vi.hoisted(() => vi.fn())

vi.mock('./walletconnect.js', () => ({
  login: loginMock,
  whoami: whoamiMock,
  logout: logoutMock,
}))
vi.mock('./mnemonic.js', () => ({ mnemonicSession: mnemonicSessionMock }))
vi.mock('./chain.js', () => ({ configureCliChain: configureCliChainMock }))
vi.mock('./commands.js', () => ({
  runRefund: runRefundMock,
  runCancel: runCancelMock,
  runClaim: runClaimMock,
  runDelete: runDeleteMock,
  runPledges: runPledgesMock,
  runCampaigns: runCampaignsMock,
}))

const SESSION = {
  address: 'ADDRESS',
  walletName: 'Pera Wallet',
}
const MNEMONIC_WALLET = { address: 'MNEMONIC_ADDRESS', signer: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('run', () => {
  it('prints usage with no arguments', async () => {
    expect(await run([])).toBe(0)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage: kasakame'))
  })

  it('prints usage with --help', async () => {
    expect(await run(['--help'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage: kasakame'))
  })

  it('prints usage with -h', async () => {
    expect(await run(['-h'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage: kasakame'))
  })

  it('logs in a new wallet session', async () => {
    loginMock.mockResolvedValue({ session: SESSION, reused: false })

    expect(await run(['login'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith('Connected Pera Wallet as ADDRESS.')
  })

  it('reports an already logged-in session', async () => {
    loginMock.mockResolvedValue({ session: SESSION, reused: true })

    expect(await run(['login'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith('Already logged in as ADDRESS (Pera Wallet).')
  })

  it('shows the current wallet session', async () => {
    whoamiMock.mockResolvedValue(SESSION)

    expect(await run(['whoami'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith('Wallet: Pera Wallet')
    expect(console.log).toHaveBeenCalledWith('Address: ADDRESS')
  })

  it('shows the mnemonic address', async () => {
    mnemonicSessionMock.mockReturnValue(MNEMONIC_WALLET)

    expect(await run(['whoami', '--signer', 'mnemonic', '--mnemonic-file', '/tmp/mnemonic'])).toBe(0)
    expect(mnemonicSessionMock).toHaveBeenCalledWith('/tmp/mnemonic')
    expect(console.log).toHaveBeenCalledWith('Signer: mnemonic')
    expect(console.log).toHaveBeenCalledWith('Address: MNEMONIC_ADDRESS')
    expect(console.log).toHaveBeenCalledWith('Network: testnet')
  })

  it('fails when there is no session', async () => {
    whoamiMock.mockResolvedValue(undefined)

    expect(await run(['whoami'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('No active wallet session. Run `kasakame login` first.')
  })

  it('disconnects the session', async () => {
    logoutMock.mockResolvedValue(true)

    expect(await run(['logout'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith('Disconnected.')
  })

  it('reports a logout with no session', async () => {
    logoutMock.mockResolvedValue(false)

    expect(await run(['logout'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith('No active wallet session.')
  })

  it('configures the chain and runs refund', async () => {
    runRefundMock.mockResolvedValue(0)

    expect(await run(['refund', '123'])).toBe(0)
    expect(configureCliChainMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'refund',
        appId: 123n,
        network: 'testnet',
        signer: 'wallet',
      }),
    )
    expect(runRefundMock).toHaveBeenCalledWith(expect.objectContaining({ appId: 123n }))
  })

  it('propagates the refund exit code', async () => {
    runRefundMock.mockResolvedValue(1)

    expect(await run(['refund', '123'])).toBe(1)
  })

  it('configures the chain and runs cancel', async () => {
    runCancelMock.mockResolvedValue(0)

    expect(await run(['cancel', '123'])).toBe(0)
    expect(configureCliChainMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'cancel', appId: 123n }))
    expect(runCancelMock).toHaveBeenCalledWith(expect.objectContaining({ appId: 123n }))
  })

  it('accepts localnet mnemonic dry-runs for claim', async () => {
    runClaimMock.mockResolvedValue(0)

    expect(await run(['claim', '5', '--network', 'localnet', '--vault', '7', '--signer', 'mnemonic', '--dry-run'])).toBe(0)
    expect(configureCliChainMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'claim',
        appId: 5n,
        network: 'localnet',
        signer: 'mnemonic',
        vaultAppId: 7n,
        dryRun: true,
      }),
    )
    expect(runClaimMock).toHaveBeenCalledWith(expect.objectContaining({ appId: 5n, dryRun: true }))
  })

  it('configures the chain and runs delete', async () => {
    runDeleteMock.mockResolvedValue(0)

    expect(await run(['delete', '123'])).toBe(0)
    expect(configureCliChainMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'delete', appId: 123n }))
    expect(runDeleteMock).toHaveBeenCalledWith(expect.objectContaining({ appId: 123n }))
  })

  it('configures the chain and lists pledges', async () => {
    runPledgesMock.mockResolvedValue(0)

    expect(await run(['pledges'])).toBe(0)
    expect(configureCliChainMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'pledges' }))
    expect(runPledgesMock).toHaveBeenCalled()
  })

  it('configures the chain and lists campaigns', async () => {
    runCampaignsMock.mockResolvedValue(0)

    expect(await run(['campaigns', '--address', 'ADDRESS'])).toBe(0)
    expect(configureCliChainMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'campaigns' }))
    expect(runCampaignsMock).toHaveBeenCalledWith(expect.objectContaining({ address: 'ADDRESS' }))
  })

  it('reports invalid arguments', async () => {
    expect(await run(['refund'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Error: refund requires exactly one app id')
    expect(configureCliChainMock).not.toHaveBeenCalled()
  })

  it('rejects mnemonic login', async () => {
    expect(await run(['login', '--signer', 'mnemonic'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Error: login only supports --signer wallet')
    expect(loginMock).not.toHaveBeenCalled()
  })

  it('prints an Error message', async () => {
    loginMock.mockRejectedValue(new Error('relay down'))

    expect(await run(['login'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Error: relay down')
  })

  it('prints a non-Error rejection', async () => {
    loginMock.mockRejectedValue('relay down')

    expect(await run(['login'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Error: relay down')
  })
})
