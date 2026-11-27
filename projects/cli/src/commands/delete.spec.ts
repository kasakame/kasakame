import type * as Sdk from '@kasakame/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliOptions } from '../app/options.js'
import { runDelete } from './delete.js'
import { HEADER, WALLET, options } from './test-fixtures.js'

const sdkMocks = vi.hoisted(() => ({
  fetchCampaignHeader: vi.fn(),
  fetchChainTimestamp: vi.fn(),
  getCampaignStatus: vi.fn(),
  deleteCampaign: vi.fn(),
}))
const withSessionMock = vi.hoisted(() => vi.fn())

vi.mock('@kasakame/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof Sdk>()
  return {
    ...sdkMocks,
    SdkError: actual.SdkError,
    classifyChainError: actual.classifyChainError,
  }
})
vi.mock('../auth/open-session.js', () => ({ withSession: withSessionMock }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', status: 'claimed' })
  sdkMocks.fetchChainTimestamp.mockResolvedValue(2_000n)
  sdkMocks.getCampaignStatus.mockReturnValue('successful')
  sdkMocks.deleteCampaign.mockResolvedValue({ txIds: ['DELETETX'], confirmedRound: 99n })
  withSessionMock.mockImplementation((_options: CliOptions, run: (wallet: typeof WALLET) => Promise<number>) => run(WALLET))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runDelete', () => {
  it('deletes a claimed campaign in one session', async () => {
    expect(await runDelete(options({ command: 'delete' }))).toBe(0)

    expect(sdkMocks.deleteCampaign).toHaveBeenCalledWith(1n, WALLET)
    expect(console.log).toHaveBeenCalledWith('Deleted campaign 1.')
    expect(console.log).toHaveBeenCalledWith("The campaign's schema MBR and any Registry registration deposit are back in your account.")
    expect(console.error).toHaveBeenCalledWith('Submitting: delete campaign 1…')
    expect(console.log).not.toHaveBeenCalledWith('Backers keep refunding from the vault until the refund window closes.')
    expect(withSessionMock).toHaveBeenCalled()
  })

  it('deletes a failed campaign and notes that backers keep refunding', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 2_000_000n })

    expect(await runDelete(options({ command: 'delete' }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith('Backers keep refunding from the vault until the refund window closes.')
  })

  it('deletes a failed campaign with nothing left to refund', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 0n })

    expect(await runDelete(options({ command: 'delete' }))).toBe(0)

    expect(sdkMocks.deleteCampaign).toHaveBeenCalledWith(1n, WALLET)
    expect(console.log).not.toHaveBeenCalledWith('Backers keep refunding from the vault until the refund window closes.')
  })

  it('deletes a pristine open campaign before its deadline', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 0n })

    expect(await runDelete(options({ command: 'delete' }))).toBe(0)
    expect(sdkMocks.deleteCampaign).toHaveBeenCalledWith(1n, WALLET)
  })

  it('prints the plan in a dry run without submitting', async () => {
    expect(await runDelete(options({ command: 'delete', dryRun: true }))).toBe(0)

    expect(sdkMocks.deleteCampaign).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would delete campaign 1 as BACKER.')
    expect(console.log).toHaveBeenCalledWith('Dry run: nothing submitted.')
    expect(withSessionMock).toHaveBeenCalled()
  })

  it('rejects an already-deleted campaign before opening the wallet', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', deleted: true })

    await expect(runDelete(options({ command: 'delete' }))).rejects.toThrow('Campaign 1 was already deleted')
    expect(withSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a funded campaign that is not claimed yet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 10_000_000n })

    await expect(runDelete(options({ command: 'delete' }))).rejects.toThrow('Campaign 1 reached its goal; claim it before deleting')
    expect(withSessionMock).not.toHaveBeenCalled()
  })

  it('rejects an open campaign with live pledges', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 2_000_000n })

    await expect(runDelete(options({ command: 'delete' }))).rejects.toThrow(
      'Campaign 1 is still open with live pledges; cancel them or wait for the deadline',
    )
    expect(withSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a wallet that did not create the campaign', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'CREATOR', status: 'claimed' })

    await expect(runDelete(options({ command: 'delete' }))).rejects.toThrow(
      'Campaign 1 was created by CREATOR; only the creator can delete it',
    )
    expect(sdkMocks.deleteCampaign).not.toHaveBeenCalled()
  })

  it('propagates a failed deletion', async () => {
    sdkMocks.deleteCampaign.mockRejectedValue(new Error('rejected'))

    await expect(runDelete(options({ command: 'delete' }))).rejects.toThrow('rejected')
    expect(withSessionMock).toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(runDelete({ command: 'delete', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'delete requires exactly one app id',
    )
  })
})
