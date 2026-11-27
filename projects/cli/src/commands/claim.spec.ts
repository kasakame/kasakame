import type * as Sdk from '@kasakame/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliOptions } from '../app/options.js'
import { runClaim } from './claim.js'
import { HEADER, WALLET, options } from './test-fixtures.js'

const sdkMocks = vi.hoisted(() => ({
  fetchCampaignHeader: vi.fn(),
  fetchChainTimestamp: vi.fn(),
  getCampaignStatus: vi.fn(),
  claim: vi.fn(),
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
  sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 10_000_000n })
  sdkMocks.fetchChainTimestamp.mockResolvedValue(2_000n)
  sdkMocks.getCampaignStatus.mockReturnValue('successful')
  sdkMocks.claim.mockResolvedValue({ txIds: ['CLAIMTX'], confirmedRound: 99n })
  withSessionMock.mockImplementation((_options: CliOptions, run: (wallet: typeof WALLET) => Promise<number>) => run(WALLET))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runClaim', () => {
  it('claims a successful campaign for its creator in one session', async () => {
    expect(await runClaim(options({ command: 'claim' }))).toBe(0)

    expect(sdkMocks.claim).toHaveBeenCalledWith(1n, WALLET)
    expect(console.log).toHaveBeenCalledWith('Claimed campaign 1; the vault paid its live total to BACKER.')
    expect(console.log).toHaveBeenCalledWith('Confirmed in round 99.')
    expect(console.log).toHaveBeenCalledWith('Transaction: CLAIMTX')
    expect(console.log).toHaveBeenCalledWith('Explorer: https://lora.algokit.io/testnet/tx/CLAIMTX')
    expect(console.error).toHaveBeenCalledWith('Submitting: claim campaign 1…')
    expect(withSessionMock).toHaveBeenCalled()
  })

  it('omits the round and transaction lines when the node returns neither', async () => {
    sdkMocks.claim.mockResolvedValue({ txIds: [] })

    expect(await runClaim(options({ command: 'claim' }))).toBe(0)
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Confirmed in round'))
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Transaction:'))
  })

  it('does not print a Lora link on a custom network', async () => {
    expect(await runClaim(options({ command: 'claim', network: 'custom' }))).toBe(0)
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Explorer:'))
  })

  it('prints the plan in a dry run without submitting', async () => {
    expect(await runClaim(options({ command: 'claim', dryRun: true }))).toBe(0)

    expect(sdkMocks.claim).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would claim campaign 1 as BACKER.')
    expect(console.log).toHaveBeenCalledWith('Dry run: nothing submitted.')
    expect(withSessionMock).toHaveBeenCalled()
  })

  it('rejects an open campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')

    await expect(runClaim(options({ command: 'claim' }))).rejects.toThrow('Campaign 1 is still open; claim opens after its deadline')
    expect(withSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a failed campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')

    await expect(runClaim(options({ command: 'claim' }))).rejects.toThrow('Campaign 1 failed; there is nothing to claim')
    expect(withSessionMock).not.toHaveBeenCalled()
  })

  it('rejects an already-claimed campaign before opening the wallet', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', status: 'claimed' })

    await expect(runClaim(options({ command: 'claim' }))).rejects.toThrow('Campaign 1 was already claimed')
    expect(withSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a wallet that did not create the campaign', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'CREATOR' })

    await expect(runClaim(options({ command: 'claim' }))).rejects.toThrow('Campaign 1 was created by CREATOR; only the creator can claim')
    expect(sdkMocks.claim).not.toHaveBeenCalled()
  })

  it('propagates a failed claim', async () => {
    sdkMocks.claim.mockRejectedValue(new Error('rejected'))

    await expect(runClaim(options({ command: 'claim' }))).rejects.toThrow('rejected')
    expect(withSessionMock).toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(runClaim({ command: 'claim', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'claim requires exactly one app id',
    )
  })
})
