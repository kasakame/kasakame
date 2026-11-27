import { SdkError } from '@kasakame/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from './run.js'

const configureNetworkMock = vi.hoisted(() => vi.fn())
const runRefundMock = vi.hoisted(() => vi.fn())
const runWithdrawMock = vi.hoisted(() => vi.fn())
const runClaimMock = vi.hoisted(() => vi.fn())
const runDeleteMock = vi.hoisted(() => vi.fn())
const runPledgesMock = vi.hoisted(() => vi.fn())
const runCampaignsMock = vi.hoisted(() => vi.fn())
const runSettleOpenMock = vi.hoisted(() => vi.fn())
const runFinalizeMock = vi.hoisted(() => vi.fn())
const runReleaseClaimedMock = vi.hoisted(() => vi.fn())
const runLoginMock = vi.hoisted(() => vi.fn())
const runWhoamiMock = vi.hoisted(() => vi.fn())
const runLogoutMock = vi.hoisted(() => vi.fn())

vi.mock('./network.js', () => ({ configureNetwork: configureNetworkMock }))
vi.mock('../commands/index.js', () => ({
  runRefund: runRefundMock,
  runWithdraw: runWithdrawMock,
  runClaim: runClaimMock,
  runDelete: runDeleteMock,
  runPledges: runPledgesMock,
  runCampaigns: runCampaignsMock,
  runSettleOpen: runSettleOpenMock,
  runFinalize: runFinalizeMock,
  runReleaseClaimed: runReleaseClaimedMock,
  runLogin: runLoginMock,
  runWhoami: runWhoamiMock,
  runLogout: runLogoutMock,
}))

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

  it('lists the vault cleanup commands in the usage', async () => {
    expect(await run(['--help'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('settle-open <appId>'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('finalize <appId>'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('release-claimed <appId>'))
  })

  it('dispatches login without configuring the chain', async () => {
    runLoginMock.mockResolvedValue(0)

    expect(await run(['login'])).toBe(0)
    expect(runLoginMock).toHaveBeenCalled()
    expect(configureNetworkMock).not.toHaveBeenCalled()
  })

  it('dispatches whoami without configuring the chain', async () => {
    runWhoamiMock.mockResolvedValue(0)

    expect(await run(['whoami'])).toBe(0)
    expect(runWhoamiMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'whoami' }))
    expect(configureNetworkMock).not.toHaveBeenCalled()
  })

  it('dispatches logout without configuring the chain', async () => {
    runLogoutMock.mockResolvedValue(0)

    expect(await run(['logout'])).toBe(0)
    expect(runLogoutMock).toHaveBeenCalled()
    expect(configureNetworkMock).not.toHaveBeenCalled()
  })

  it('configures the chain and runs refund', async () => {
    runRefundMock.mockResolvedValue(0)

    expect(await run(['refund', '123'])).toBe(0)
    expect(configureNetworkMock).toHaveBeenCalledWith(
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

  it('configures the chain and runs withdraw', async () => {
    runWithdrawMock.mockResolvedValue(0)

    expect(await run(['withdraw', '123'])).toBe(0)
    expect(configureNetworkMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'withdraw', appId: 123n }))
    expect(runWithdrawMock).toHaveBeenCalledWith(expect.objectContaining({ appId: 123n }))
  })

  it('accepts localnet mnemonic dry-runs for claim', async () => {
    runClaimMock.mockResolvedValue(0)

    expect(await run(['claim', '5', '--network', 'localnet', '--vault', '7', '--signer', 'mnemonic', '--dry-run'])).toBe(0)
    expect(configureNetworkMock).toHaveBeenCalledWith(
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
    expect(configureNetworkMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'delete', appId: 123n }))
    expect(runDeleteMock).toHaveBeenCalledWith(expect.objectContaining({ appId: 123n }))
  })

  it.each([
    ['settle-open', runSettleOpenMock],
    ['finalize', runFinalizeMock],
    ['release-claimed', runReleaseClaimedMock],
  ] as const)('configures the chain and runs %s', async (command, runner) => {
    runner.mockResolvedValue(0)

    expect(await run([command, '123'])).toBe(0)
    expect(configureNetworkMock).toHaveBeenCalledWith(expect.objectContaining({ command, appId: 123n }))
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ appId: 123n }))
  })

  it('configures the chain and lists pledges', async () => {
    runPledgesMock.mockResolvedValue(0)

    expect(await run(['pledges'])).toBe(0)
    expect(configureNetworkMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'pledges' }))
    expect(runPledgesMock).toHaveBeenCalled()
  })

  it('configures the chain and lists campaigns', async () => {
    runCampaignsMock.mockResolvedValue(0)

    expect(await run(['campaigns', '--address', 'ADDRESS'])).toBe(0)
    expect(configureNetworkMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'campaigns' }))
    expect(runCampaignsMock).toHaveBeenCalledWith(expect.objectContaining({ address: 'ADDRESS' }))
  })

  it('reports invalid arguments', async () => {
    expect(await run(['refund'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Error: refund requires exactly one app id')
    expect(configureNetworkMock).not.toHaveBeenCalled()
  })

  it('prints an Error message', async () => {
    runLoginMock.mockRejectedValue(new Error('relay down'))

    expect(await run(['login'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Error: relay down')
  })

  it('prints a non-Error rejection', async () => {
    runLoginMock.mockRejectedValue('relay down')

    expect(await run(['login'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Error: Could not connect the wallet. Please try again.')
  })

  it('maps SDK failures and hides the raw chain message by default', async () => {
    runClaimMock.mockRejectedValue(new SdkError('stale-proof', 'transaction ABC: logic eval error: proof does not match root'))

    expect(await run(['claim', '1'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Error: Another pledge or refund landed first. Retry the command.')
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('logic eval error'))
  })

  it('prints the raw SDK message only at debug level', async () => {
    runClaimMock.mockRejectedValue(new SdkError('network', 'fetch failed'))

    expect(await run(['claim', '1', '--log-level', 'debug'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Error: Could not reach the chain. Check your connection and try again.')
    expect(console.error).toHaveBeenCalledWith('[detail] fetch failed')
  })
})
