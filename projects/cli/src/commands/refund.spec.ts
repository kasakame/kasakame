import type * as Sdk from '@kasakame/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../app/context.js'
import type { CliOptions } from '../app/options.js'
import { runRefund } from './refund.js'
import { HEADER, WALLET, commandContext, commandContextWithoutAppId, leaf, type FakeContext } from './test-fixtures.js'

const sdkMocks = vi.hoisted(() => ({
  fetchCampaignHeader: vi.fn(),
  fetchChainTimestamp: vi.fn(),
  getCampaignStatus: vi.fn(),
  fetchMyLeaves: vi.fn(),
  refund: vi.fn(),
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
  sdkMocks.getCampaignStatus.mockReturnValue('failed')
  sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_500_000n), leaf(1, 1n)])
  sdkMocks.refund.mockResolvedValue({ txIds: ['REFUNDTX'], confirmedRound: 99n })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runRefund', () => {
  it('refunds every live pledge in one session', async () => {
    expect(await runRefund(ctx({ all: true }))).toBe(0)

    expect(sdkMocks.fetchCampaignHeader).toHaveBeenCalledWith(1n)
    expect(sdkMocks.getCampaignStatus).toHaveBeenCalledWith(HEADER, 2_000n)
    expect(sdkMocks.fetchMyLeaves).toHaveBeenCalledWith(1n, 'BACKER')
    expect(sdkMocks.refund).toHaveBeenCalledTimes(2)
    expect(sdkMocks.refund).toHaveBeenNthCalledWith(1, 1n, WALLET, leaf(0, 1_500_000n))
    expect(sdkMocks.refund).toHaveBeenNthCalledWith(2, 1n, WALLET, leaf(1, 1n))
    expect(console.log).toHaveBeenCalledWith('Refunded pledge #0 (1.5 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Refunded pledge #1 (0.000001 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Refunded 2 pledges.')
    expect(console.error).toHaveBeenCalledWith('2 pledges selected; each is a separate transaction.')
    expect(console.error).toHaveBeenCalledWith('Submitting: refund pledge #0 (1.5 ALGO)…')
    expect(lastContext.session).toHaveBeenCalled()
  })

  it('announces the wallet approval for the wallet signer', async () => {
    expect(await runRefund(ctx({ signer: 'wallet', all: true }))).toBe(0)
    expect(console.error).toHaveBeenCalledWith('2 pledges selected; your wallet asks for approval on each one.')
    expect(console.error).toHaveBeenCalledWith('Waiting for wallet approval: refund pledge #0 (1.5 ALGO)…')
  })

  it('refunds one selected pledge', async () => {
    expect(await runRefund(ctx({ pledge: 1 }))).toBe(0)

    expect(sdkMocks.refund).toHaveBeenCalledTimes(1)
    expect(sdkMocks.refund).toHaveBeenCalledWith(1n, WALLET, leaf(1, 1n))
    expect(console.log).toHaveBeenCalledWith('Refunded pledge #1 (0.000001 ALGO).')
  })

  it('prints planned refunds in a dry run without submitting', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_000_000n)])

    expect(await runRefund(ctx({ dryRun: true }))).toBe(0)

    expect(sdkMocks.refund).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would refund pledge #0 (1 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Dry run: 1 pledge would be refunded.')
    expect(lastContext.session).toHaveBeenCalled()
  })

  it('keeps going after a failed pledge and exits non-zero', async () => {
    sdkMocks.refund.mockRejectedValueOnce(new Error('rejected')).mockResolvedValueOnce({ txIds: ['REFUNDTX'], confirmedRound: 99n })

    expect(await runRefund(ctx({ all: true }))).toBe(1)

    expect(sdkMocks.refund).toHaveBeenCalledTimes(2)
    expect(console.error).toHaveBeenCalledWith('Pledge #0 failed: Transaction rejected in the wallet.')
    expect(console.error).toHaveBeenCalledWith('Refunded 1 of 2 pledges; 1 failed.')
  })

  it('reports a non-Error failure', async () => {
    sdkMocks.refund.mockRejectedValue('rejected')

    expect(await runRefund(ctx({ all: true }))).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Pledge #0 failed: Could not refund the pledges. Please try again.')
  })

  it('prints the raw failure only at debug level', async () => {
    sdkMocks.refund.mockRejectedValue(new Error('Transaction rejected by user'))

    expect(await runRefund(ctx({ all: true, logLevel: 'debug' }))).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Pledge #0 failed: Transaction rejected in the wallet.')
    expect(console.error).toHaveBeenCalledWith('[detail] Transaction rejected by user')
  })

  it('does not print a detail for a non-Error at debug level', async () => {
    sdkMocks.refund.mockRejectedValue('rejected')

    expect(await runRefund(ctx({ all: true, logLevel: 'debug' }))).toBe(1)
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('[detail]'))
  })

  it('reports no live pledges', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([])

    expect(await runRefund(ctx())).toBe(0)

    expect(sdkMocks.refund).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('No live pledges to refund from campaign 1.')
    expect(lastContext.session).toHaveBeenCalled()
  })

  it('propagates a fetch failure', async () => {
    sdkMocks.fetchMyLeaves.mockRejectedValue(new Error('indexer down'))

    await expect(runRefund(ctx())).rejects.toThrow('indexer down')
  })

  it('rejects an open campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')

    await expect(runRefund(ctx())).rejects.toThrow('Campaign 1 is still open; use `kasakame withdraw` before the deadline')
    expect(lastContext.session).not.toHaveBeenCalled()
  })

  it('rejects a successful campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')

    await expect(runRefund(ctx())).rejects.toThrow('Campaign 1 succeeded; there is nothing to refund')
    expect(lastContext.session).not.toHaveBeenCalled()
  })

  it('rejects an unknown campaign', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue(undefined)

    await expect(runRefund(ctx())).rejects.toThrow('Campaign 1 not found')
    expect(lastContext.session).not.toHaveBeenCalled()
  })

  it('turns a missing campaign into a clear error', async () => {
    sdkMocks.fetchCampaignHeader.mockRejectedValue(
      new Error('Network request error. Received status 404 (Not Found): no application found for application-id: 999999999'),
    )

    await expect(runRefund(ctx())).rejects.toThrow('Campaign 1 not found on testnet')
    expect(lastContext.session).not.toHaveBeenCalled()
  })

  it('treats a non-Error 404 as not found', async () => {
    sdkMocks.fetchCampaignHeader.mockRejectedValue('404')

    await expect(runRefund(ctx())).rejects.toThrow('Campaign 1 not found on testnet')
  })

  it('keeps unexpected indexer errors', async () => {
    sdkMocks.fetchCampaignHeader.mockRejectedValue(new Error('indexer down'))

    await expect(runRefund(ctx())).rejects.toThrow('indexer down')
  })

  it('requires an app id', async () => {
    await expect(
      runRefund(commandContextWithoutAppId({ command: 'refund', network: 'testnet', signer: 'mnemonic', dryRun: false })),
    ).rejects.toThrow('refund requires exactly one app id')
  })
})
