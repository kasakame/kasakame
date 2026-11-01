import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliOptions } from './args.js'
import { runCampaigns, runCancel, runClaim, runDelete, runPledges, runRefund } from './commands.js'

const sdkMocks = vi.hoisted(() => ({
  enumerateCampaigns: vi.fn(),
  fetchCampaignHeader: vi.fn(),
  fetchChainTimestamp: vi.fn(),
  getCampaignStatus: vi.fn(),
  fetchMyLeaves: vi.fn(),
  cancelPledge: vi.fn(),
  claim: vi.fn(),
  deleteCampaign: vi.fn(),
  refund: vi.fn(),
}))
const closeMock = vi.hoisted(() => vi.fn(async () => {}))
const openCliSessionMock = vi.hoisted(() => vi.fn())
const whoamiMock = vi.hoisted(() => vi.fn())
const mnemonicSessionMock = vi.hoisted(() => vi.fn())

vi.mock('@kasakame/sdk', () => sdkMocks)
vi.mock('./session.js', () => ({ openCliSession: openCliSessionMock }))
vi.mock('./walletconnect.js', () => ({ whoami: whoamiMock }))
vi.mock('./mnemonic.js', () => ({ mnemonicSession: mnemonicSessionMock }))

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
  sdkMocks.deleteCampaign.mockResolvedValue(undefined)
  sdkMocks.refund.mockResolvedValue(undefined)
  mnemonicSessionMock.mockReturnValue(WALLET)
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

describe('runDelete', () => {
  function deleteOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return options({ command: 'delete', ...overrides })
  }

  beforeEach(() => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', status: 'claimed' })
  })

  it('deletes a claimed campaign and closes the session', async () => {
    expect(await runDelete(deleteOptions())).toBe(0)

    expect(sdkMocks.deleteCampaign).toHaveBeenCalledWith(1n, WALLET)
    expect(console.log).toHaveBeenCalledWith('Deleted campaign 1.')
    expect(console.log).toHaveBeenCalledWith("The campaign's schema MBR and any Factory registration deposit are back in your account.")
    expect(console.log).not.toHaveBeenCalledWith('Backers keep refunding from the vault until the refund window closes.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('deletes a failed campaign and notes that backers keep refunding', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 2_000_000n })

    expect(await runDelete(deleteOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith('Backers keep refunding from the vault until the refund window closes.')
  })

  it('deletes a failed campaign with nothing left to refund', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 0n })

    expect(await runDelete(deleteOptions())).toBe(0)

    expect(sdkMocks.deleteCampaign).toHaveBeenCalledWith(1n, WALLET)
    expect(console.log).not.toHaveBeenCalledWith('Backers keep refunding from the vault until the refund window closes.')
  })

  it('deletes a pristine open campaign before its deadline', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 0n })

    expect(await runDelete(deleteOptions())).toBe(0)
    expect(sdkMocks.deleteCampaign).toHaveBeenCalledWith(1n, WALLET)
  })

  it('prints the plan in a dry run without submitting', async () => {
    expect(await runDelete(deleteOptions({ dryRun: true }))).toBe(0)

    expect(sdkMocks.deleteCampaign).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would delete campaign 1 as BACKER.')
    expect(console.log).toHaveBeenCalledWith('Dry run: nothing submitted.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('rejects an already-deleted campaign before opening the wallet', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', deleted: true })

    await expect(runDelete(deleteOptions())).rejects.toThrow('Campaign 1 was already deleted')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a funded campaign that is not claimed yet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 10_000_000n })

    await expect(runDelete(deleteOptions())).rejects.toThrow('Campaign 1 reached its goal; claim it before deleting')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects an open campaign with live pledges', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 2_000_000n })

    await expect(runDelete(deleteOptions())).rejects.toThrow(
      'Campaign 1 is still open with live pledges; cancel them or wait for the deadline',
    )
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a wallet that did not create the campaign', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'CREATOR', status: 'claimed' })

    await expect(runDelete(deleteOptions())).rejects.toThrow('Campaign 1 was created by CREATOR; only the creator can delete it')
    expect(sdkMocks.deleteCampaign).not.toHaveBeenCalled()
    expect(closeMock).toHaveBeenCalled()
  })

  it('closes the session when the deletion fails', async () => {
    sdkMocks.deleteCampaign.mockRejectedValue(new Error('rejected'))

    await expect(runDelete(deleteOptions())).rejects.toThrow('rejected')
    expect(closeMock).toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(runDelete({ command: 'delete', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'delete requires exactly one app id',
    )
  })
})

describe('runPledges', () => {
  const VALID_ADDRESS = '4JBYQTVKROJEKG6IZWFAOGGAM2KH65E7JUSC3S5C4EPYOCWGZJOYIRKGRI'

  function pledgeOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return options({ command: 'pledges', ...overrides })
  }

  beforeEach(() => {
    sdkMocks.enumerateCampaigns.mockResolvedValue(new Set([1n]))
    sdkMocks.getCampaignStatus.mockReturnValue('open')
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_500_000n)])
  })

  it('lists a live pledge with the cancel action', async () => {
    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith('Live pledges for BACKER on testnet:')
    expect(console.log).toHaveBeenCalledWith('#1 "Title" open, deadline 1970-01-01T00:16:40.000Z, pledged 1.5 ALGO, next: cancel')
  })

  it('lists a failed pledge with the refund action', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')

    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('next: refund'))
  })

  it('lists a successful pledge with nothing to do', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')

    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('next: none'))
  })

  it('keeps a deleted pledge visible with the refund window closed', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, deleted: true })

    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('open, deleted'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('next: none (refund window closed)'))
  })

  it('keeps a deleted pledge refundable while its box is open', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, deleted: true })
    sdkMocks.getCampaignStatus.mockReturnValue('failed')

    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('failed, deleted'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('next: refund'))
  })

  it('reports no live pledges', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([])

    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith('No live pledges for BACKER on testnet.')
  })

  it('inspects an explicit address without a signer', async () => {
    expect(await runPledges(pledgeOptions({ address: VALID_ADDRESS }))).toBe(0)

    expect(mnemonicSessionMock).not.toHaveBeenCalled()
    expect(whoamiMock).not.toHaveBeenCalled()
    expect(sdkMocks.fetchMyLeaves).toHaveBeenCalledWith(1n, VALID_ADDRESS)
  })

  it('rejects an invalid address', async () => {
    await expect(runPledges(pledgeOptions({ address: 'ADDRESS' }))).rejects.toThrow('Invalid address: ADDRESS')
  })

  it('reads the address from the stored wallet session', async () => {
    whoamiMock.mockResolvedValue({ address: 'WALLET_ADDRESS' })

    expect(await runPledges(pledgeOptions({ signer: 'wallet' }))).toBe(0)

    expect(mnemonicSessionMock).not.toHaveBeenCalled()
    expect(sdkMocks.fetchMyLeaves).toHaveBeenCalledWith(1n, 'WALLET_ADDRESS')
  })

  it('requires a wallet session or an address', async () => {
    whoamiMock.mockResolvedValue(undefined)

    await expect(runPledges(pledgeOptions({ signer: 'wallet' }))).rejects.toThrow(
      'No active wallet session. Run `kasakame login` first, or pass --address',
    )
  })
})

describe('runCampaigns', () => {
  function campaignOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return options({ command: 'campaigns', ...overrides })
  }

  function header(overrides: Record<string, unknown>) {
    return { ...HEADER, ...overrides }
  }

  it('lists the action available for each creator campaign', async () => {
    const headers = new Map<bigint, Record<string, unknown>>([
      [1n, header({ id: 1n, title: 'Claimed', creator: 'BACKER', status: 'claimed', raisedMicroAlgos: 10_000_000n })],
      [2n, header({ id: 2n, title: 'Funded', creator: 'BACKER', raisedMicroAlgos: 10_000_000n })],
      [3n, header({ id: 3n, title: 'Failed', creator: 'BACKER', goalMicroAlgos: 5_000_000n, raisedMicroAlgos: 2_000_000n })],
      [4n, header({ id: 4n, title: 'Empty', creator: 'BACKER', raisedMicroAlgos: 0n })],
      [5n, header({ id: 5n, title: 'Live', creator: 'BACKER', raisedMicroAlgos: 2_000_000n })],
      [6n, header({ id: 6n, title: 'Gone', creator: 'BACKER', deleted: true })],
      [7n, header({ id: 7n, title: 'Other', creator: 'OTHER' })],
    ])
    const statuses = new Map<bigint, string>([
      [1n, 'successful'],
      [2n, 'successful'],
      [3n, 'failed'],
      [4n, 'open'],
      [5n, 'open'],
      [6n, 'failed'],
      [7n, 'open'],
    ])
    sdkMocks.enumerateCampaigns.mockResolvedValue(new Set([1n, 2n, 3n, 4n, 5n, 6n, 7n]))
    sdkMocks.fetchCampaignHeader.mockImplementation((id: bigint) => headers.get(id))
    sdkMocks.getCampaignStatus.mockImplementation((entry: { id: bigint }) => statuses.get(entry.id))

    expect(await runCampaigns(campaignOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith('Campaigns created by BACKER on testnet:')
    expect(console.log).toHaveBeenCalledWith(
      '#1 "Claimed" successful (claimed), raised 10 of 10 ALGO, deadline 1970-01-01T00:16:40.000Z, next: delete',
    )
    expect(console.log).toHaveBeenCalledWith('#2 "Funded" successful, raised 10 of 10 ALGO, deadline 1970-01-01T00:16:40.000Z, next: claim')
    expect(console.log).toHaveBeenCalledWith('#3 "Failed" failed, raised 2 of 5 ALGO, deadline 1970-01-01T00:16:40.000Z, next: delete')
    expect(console.log).toHaveBeenCalledWith('#4 "Empty" open, raised 0 of 10 ALGO, deadline 1970-01-01T00:16:40.000Z, next: delete')
    expect(console.log).toHaveBeenCalledWith('#5 "Live" open, raised 2 of 10 ALGO, deadline 1970-01-01T00:16:40.000Z, next: none')
    expect(console.log).toHaveBeenCalledWith(
      '#6 "Gone" failed, deleted, raised 2 of 10 ALGO, deadline 1970-01-01T00:16:40.000Z, next: none',
    )
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('"Other"'))
  })

  it('reports no campaigns for the address', async () => {
    sdkMocks.enumerateCampaigns.mockResolvedValue(new Set())

    expect(await runCampaigns(campaignOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith('No campaigns created by BACKER on testnet.')
  })

  it('skips ids the indexer does not know', async () => {
    sdkMocks.enumerateCampaigns.mockResolvedValue(new Set([1n, 2n]))
    sdkMocks.fetchCampaignHeader.mockImplementation((id: bigint) =>
      id === 1n ? header({ creator: 'BACKER', raisedMicroAlgos: 0n }) : undefined,
    )
    sdkMocks.getCampaignStatus.mockReturnValue('open')

    expect(await runCampaigns(campaignOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith('Campaigns created by BACKER on testnet:')
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('next: delete'))
  })
})
