import type * as Sdk from '@kasakame/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../app/context.js'
import type { CliOptions } from '../app/options.js'
import { HEADER, WALLET, commandContext, commandContextWithoutAppId, leaf, type FakeContext } from './test-fixtures.js'
import { runWithdraw } from './withdraw.js'

const sdkMocks = vi.hoisted(() => ({
  fetchCampaignHeader: vi.fn(),
  fetchChainTimestamp: vi.fn(),
  getCampaignStatus: vi.fn(),
  fetchMyLeaves: vi.fn(),
  cancelPledge: vi.fn(),
}))

let lastContext: FakeContext

function ctx(overrides: Partial<CliOptions> = {}): CommandContext {
  lastContext = commandContext(overrides)
  return lastContext
}

vi.mock('@kasakame/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof Sdk>()
  return {
    ...sdkMocks,
    SdkError: actual.SdkError,
    classifyChainError: actual.classifyChainError,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  sdkMocks.fetchCampaignHeader.mockResolvedValue(HEADER)
  sdkMocks.fetchChainTimestamp.mockResolvedValue(2_000n)
  sdkMocks.getCampaignStatus.mockReturnValue('open')
  sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_500_000n), leaf(1, 1n)])
  sdkMocks.cancelPledge.mockResolvedValue({ txIds: ['CANCELTX'], confirmedRound: 99n })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runWithdraw', () => {
  it('withdraws every live pledge with --all in one session', async () => {
    expect(await runWithdraw(ctx({ command: 'withdraw', all: true }))).toBe(0)

    expect(sdkMocks.fetchMyLeaves).toHaveBeenCalledWith(1n, 'BACKER')
    expect(sdkMocks.cancelPledge).toHaveBeenCalledTimes(2)
    expect(sdkMocks.cancelPledge).toHaveBeenNthCalledWith(1, 1n, WALLET, leaf(0, 1_500_000n))
    expect(sdkMocks.cancelPledge).toHaveBeenNthCalledWith(2, 1n, WALLET, leaf(1, 1n))
    expect(console.log).toHaveBeenCalledWith('Withdrawn pledge #0 (1.5 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Withdrawn pledge #1 (0.000001 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Withdrawn 2 pledges.')
    expect(console.error).toHaveBeenCalledWith('2 pledges selected; each is a separate transaction.')
    expect(console.error).toHaveBeenCalledWith('Submitting: withdraw pledge #0 (1.5 ALGO)…')
    expect(lastContext.session).toHaveBeenCalled()
  })

  it('withdraws one selected pledge with --pledge', async () => {
    expect(await runWithdraw(ctx({ command: 'withdraw', pledge: 1 }))).toBe(0)

    expect(sdkMocks.cancelPledge).toHaveBeenCalledTimes(1)
    expect(sdkMocks.cancelPledge).toHaveBeenCalledWith(1n, WALLET, leaf(1, 1n))
    expect(console.log).toHaveBeenCalledWith('Withdrawn pledge #1 (0.000001 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Withdrawn 1 pledge.')
  })

  it('withdraws a single pledge without a flag', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_500_000n)])

    expect(await runWithdraw(ctx({ command: 'withdraw' }))).toBe(0)
    expect(sdkMocks.cancelPledge).toHaveBeenCalledTimes(1)
  })

  it('requires a selection when several pledges are live', async () => {
    await expect(runWithdraw(ctx({ command: 'withdraw' }))).rejects.toThrow(
      'You have 2 live pledges in campaign 1; pass --pledge <position> or --all',
    )
    expect(sdkMocks.cancelPledge).not.toHaveBeenCalled()
  })

  it('rejects an unknown leaf', async () => {
    await expect(runWithdraw(ctx({ command: 'withdraw', pledge: 9 }))).rejects.toThrow('No live pledge #9 in campaign 1')
    expect(sdkMocks.cancelPledge).not.toHaveBeenCalled()
  })

  it('prints planned withdrawals in a dry run without submitting', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_000_000n)])

    expect(await runWithdraw(ctx({ command: 'withdraw', dryRun: true }))).toBe(0)

    expect(sdkMocks.cancelPledge).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would withdraw pledge #0 (1 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Dry run: 1 pledge would be withdrawn.')
    expect(lastContext.session).toHaveBeenCalled()
  })

  it('keeps going after a failed withdrawal and exits non-zero', async () => {
    sdkMocks.cancelPledge.mockRejectedValueOnce(new Error('rejected')).mockResolvedValueOnce({ txIds: ['CANCELTX'], confirmedRound: 99n })

    expect(await runWithdraw(ctx({ command: 'withdraw', all: true }))).toBe(1)

    expect(sdkMocks.cancelPledge).toHaveBeenCalledTimes(2)
    expect(console.error).toHaveBeenCalledWith('Pledge #0 failed: Transaction rejected in the wallet.')
    expect(console.error).toHaveBeenCalledWith('Withdrawn 1 of 2 pledges; 1 failed.')
  })

  it('reports no live pledges', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([])

    expect(await runWithdraw(ctx({ command: 'withdraw' }))).toBe(0)

    expect(sdkMocks.cancelPledge).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('No live pledges to withdraw from campaign 1.')
  })

  it('rejects a failed campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')

    await expect(runWithdraw(ctx({ command: 'withdraw' }))).rejects.toThrow('Campaign 1 already failed; use `kasakame refund` instead')
    expect(lastContext.session).not.toHaveBeenCalled()
  })

  it('rejects a successful campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')

    await expect(runWithdraw(ctx({ command: 'withdraw' }))).rejects.toThrow('Campaign 1 succeeded; its pledges can no longer be withdrawn')
    expect(lastContext.session).not.toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(
      runWithdraw(commandContextWithoutAppId({ command: 'withdraw', network: 'testnet', signer: 'mnemonic', dryRun: false })),
    ).rejects.toThrow('withdraw requires exactly one app id')
  })
})
