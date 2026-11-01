import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliOptions } from './args.js'
import { runCancel, runClaim, runRefund } from './commands.js'

const sdkMocks = vi.hoisted(() => ({
  fetchCampaignHeader: vi.fn(),
  fetchChainTimestamp: vi.fn(),
  getCampaignStatus: vi.fn(),
  fetchMyLeaves: vi.fn(),
  cancelPledge: vi.fn(),
  claim: vi.fn(),
  refund: vi.fn(),
}))
const closeMock = vi.hoisted(() => vi.fn(async () => {}))
const openCliSessionMock = vi.hoisted(() => vi.fn())

vi.mock('@kasakame/sdk', () => sdkMocks)
vi.mock('./session.js', () => ({ openCliSession: openCliSessionMock }))

const WALLET = { address: 'BACKER', signer: vi.fn() }
const HEADER = {
  id: 1n,
  creator: 'CREATOR',
  title: 'Title',
  metadataUri: 'ipfs://metadata',
  goalMicroAlgos: 10_000_000n,
  deadlineSeconds: 1_000n,
  raisedMicroAlgos: 2_000_000n,
  status: 'open' as const,
  deleted: false,
}

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

function leaf(position: number, amount: bigint) {
  return { position, amount, txidHex: 'aa' }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  sdkMocks.fetchCampaignHeader.mockResolvedValue(HEADER)
  sdkMocks.fetchChainTimestamp.mockResolvedValue(2_000n)
  sdkMocks.getCampaignStatus.mockReturnValue('failed')
  sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_500_000n), leaf(1, 1n)])
  sdkMocks.cancelPledge.mockResolvedValue(undefined)
  sdkMocks.claim.mockResolvedValue(undefined)
  sdkMocks.refund.mockResolvedValue(undefined)
  openCliSessionMock.mockResolvedValue({ wallet: WALLET, close: closeMock })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runRefund', () => {
  it('refunds every live pledge and closes the session', async () => {
    expect(await runRefund(options())).toBe(0)

    expect(sdkMocks.fetchCampaignHeader).toHaveBeenCalledWith(1n)
    expect(sdkMocks.getCampaignStatus).toHaveBeenCalledWith(HEADER, 2_000n)
    expect(sdkMocks.fetchMyLeaves).toHaveBeenCalledWith(1n, 'BACKER')
    expect(sdkMocks.refund).toHaveBeenCalledTimes(2)
    expect(sdkMocks.refund).toHaveBeenNthCalledWith(1, 1n, WALLET, leaf(0, 1_500_000n))
    expect(sdkMocks.refund).toHaveBeenNthCalledWith(2, 1n, WALLET, leaf(1, 1n))
    expect(console.log).toHaveBeenCalledWith('Refunded pledge #0 (1.5 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Refunded pledge #1 (0.000001 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Refunded 2 pledges.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('prints planned refunds in a dry run without submitting', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_000_000n)])

    expect(await runRefund(options({ dryRun: true }))).toBe(0)

    expect(sdkMocks.refund).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would refund pledge #0 (1 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Dry run: 1 pledge would be refunded.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('keeps going after a failed pledge and exits non-zero', async () => {
    sdkMocks.refund.mockRejectedValueOnce(new Error('rejected')).mockResolvedValueOnce(undefined)

    expect(await runRefund(options())).toBe(1)

    expect(sdkMocks.refund).toHaveBeenCalledTimes(2)
    expect(console.error).toHaveBeenCalledWith('Pledge #0 failed: rejected')
    expect(console.error).toHaveBeenCalledWith('Refunded 1 of 2 pledges; 1 failed.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('reports a non-Error failure', async () => {
    sdkMocks.refund.mockRejectedValue('rejected')

    expect(await runRefund(options())).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Pledge #0 failed: rejected')
  })

  it('reports no live pledges', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([])

    expect(await runRefund(options())).toBe(0)

    expect(sdkMocks.refund).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('No live pledges to refund from campaign 1.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('closes the session when fetching leaves fails', async () => {
    sdkMocks.fetchMyLeaves.mockRejectedValue(new Error('indexer down'))

    await expect(runRefund(options())).rejects.toThrow('indexer down')
    expect(closeMock).toHaveBeenCalled()
  })

  it('rejects an open campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')

    await expect(runRefund(options())).rejects.toThrow('Campaign 1 is still open; use `kasakame cancel` before the deadline')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a successful campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')

    await expect(runRefund(options())).rejects.toThrow('Campaign 1 succeeded; there is nothing to refund')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects an unknown campaign', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue(undefined)

    await expect(runRefund(options())).rejects.toThrow('Campaign 1 not found')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(runRefund({ command: 'refund', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'refund requires exactly one app id',
    )
  })
})

describe('runCancel', () => {
  function cancelOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return options({ command: 'cancel', ...overrides })
  }

  beforeEach(() => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')
  })

  it('cancels every live pledge and closes the session', async () => {
    expect(await runCancel(cancelOptions())).toBe(0)

    expect(sdkMocks.fetchMyLeaves).toHaveBeenCalledWith(1n, 'BACKER')
    expect(sdkMocks.cancelPledge).toHaveBeenCalledTimes(2)
    expect(sdkMocks.cancelPledge).toHaveBeenNthCalledWith(1, 1n, WALLET, leaf(0, 1_500_000n))
    expect(sdkMocks.cancelPledge).toHaveBeenNthCalledWith(2, 1n, WALLET, leaf(1, 1n))
    expect(console.log).toHaveBeenCalledWith('Cancelled pledge #0 (1.5 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Cancelled 2 pledges.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('prints planned cancellations in a dry run without submitting', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_000_000n)])

    expect(await runCancel(cancelOptions({ dryRun: true }))).toBe(0)

    expect(sdkMocks.cancelPledge).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would cancel pledge #0 (1 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Dry run: 1 pledge would be cancelled.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('keeps going after a failed cancellation and exits non-zero', async () => {
    sdkMocks.cancelPledge.mockRejectedValueOnce(new Error('rejected')).mockResolvedValueOnce(undefined)

    expect(await runCancel(cancelOptions())).toBe(1)

    expect(sdkMocks.cancelPledge).toHaveBeenCalledTimes(2)
    expect(console.error).toHaveBeenCalledWith('Pledge #0 failed: rejected')
    expect(console.error).toHaveBeenCalledWith('Cancelled 1 of 2 pledges; 1 failed.')
  })

  it('reports no live pledges', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([])

    expect(await runCancel(cancelOptions())).toBe(0)

    expect(sdkMocks.cancelPledge).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('No live pledges to cancel from campaign 1.')
  })

  it('rejects a failed campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')

    await expect(runCancel(cancelOptions())).rejects.toThrow('Campaign 1 already failed; use `kasakame refund` instead')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a successful campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')

    await expect(runCancel(cancelOptions())).rejects.toThrow('Campaign 1 succeeded; its pledges can no longer be cancelled')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(runCancel({ command: 'cancel', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'cancel requires exactly one app id',
    )
  })
})

describe('runClaim', () => {
  function claimOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return options({ command: 'claim', ...overrides })
  }

  beforeEach(() => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 10_000_000n })
  })

  it('claims a successful campaign for its creator and closes the session', async () => {
    expect(await runClaim(claimOptions())).toBe(0)

    expect(sdkMocks.claim).toHaveBeenCalledWith(1n, WALLET)
    expect(console.log).toHaveBeenCalledWith('Claimed campaign 1; the vault paid its live total to BACKER.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('prints the plan in a dry run without submitting', async () => {
    expect(await runClaim(claimOptions({ dryRun: true }))).toBe(0)

    expect(sdkMocks.claim).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would claim campaign 1 as BACKER.')
    expect(console.log).toHaveBeenCalledWith('Dry run: nothing submitted.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('rejects an open campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')

    await expect(runClaim(claimOptions())).rejects.toThrow('Campaign 1 is still open; claim opens after its deadline')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a failed campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')

    await expect(runClaim(claimOptions())).rejects.toThrow('Campaign 1 failed; there is nothing to claim')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects an already-claimed campaign before opening the wallet', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', status: 'claimed' })

    await expect(runClaim(claimOptions())).rejects.toThrow('Campaign 1 was already claimed')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a wallet that did not create the campaign', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'CREATOR' })

    await expect(runClaim(claimOptions())).rejects.toThrow('Campaign 1 was created by CREATOR; only the creator can claim')
    expect(sdkMocks.claim).not.toHaveBeenCalled()
    expect(closeMock).toHaveBeenCalled()
  })

  it('closes the session when the claim fails', async () => {
    sdkMocks.claim.mockRejectedValue(new Error('rejected'))

    await expect(runClaim(claimOptions())).rejects.toThrow('rejected')
    expect(closeMock).toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(runClaim({ command: 'claim', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'claim requires exactly one app id',
    )
  })
})
