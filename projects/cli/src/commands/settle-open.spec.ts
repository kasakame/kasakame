import type * as Sdk from '@kasakame/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliOptions } from '../app/options.js'
import { runSettleOpen } from './settle-open.js'
import { HEADER, VAULT_CLAIMED, VAULT_FAILED, VAULT_OPEN, WALLET, options, vaultBox } from './test-fixtures.js'

const sdkMocks = vi.hoisted(() => ({
  fetchCampaignHeader: vi.fn(),
  fetchChainTimestamp: vi.fn(),
  getCampaignStatus: vi.fn(),
  fetchVaultBox: vi.fn(),
  settleOpen: vi.fn(),
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
  sdkMocks.fetchCampaignHeader.mockResolvedValue(HEADER)
  sdkMocks.fetchChainTimestamp.mockResolvedValue(2_000n)
  sdkMocks.getCampaignStatus.mockReturnValue('failed')
  sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_OPEN))
  sdkMocks.settleOpen.mockResolvedValue({ txIds: ['SETTLETX'], confirmedRound: 99n })
  withSessionMock.mockImplementation((_options: CliOptions, run: (wallet: typeof WALLET) => Promise<number>) => run(WALLET))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runSettleOpen', () => {
  it('settles an open campaign in one session', async () => {
    expect(await runSettleOpen(options({ command: 'settle-open' }))).toBe(0)

    expect(sdkMocks.settleOpen).toHaveBeenCalledWith(1n, WALLET)
    expect(console.error).toHaveBeenCalledWith('Submitting: settle open campaign 1…')
    expect(console.log).toHaveBeenCalledWith('Settled campaign 1 as failed; backers can now refund through the vault.')
    expect(withSessionMock).toHaveBeenCalled()
  })

  it('prints the plan in a dry run without submitting', async () => {
    expect(await runSettleOpen(options({ command: 'settle-open', dryRun: true }))).toBe(0)

    expect(sdkMocks.settleOpen).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would settle campaign 1 as failed.')
    expect(console.log).toHaveBeenCalledWith('Dry run: nothing submitted.')
    expect(withSessionMock).toHaveBeenCalled()
  })

  it('rejects a deleted campaign before opening the wallet', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, deleted: true })

    await expect(runSettleOpen(options({ command: 'settle-open' }))).rejects.toThrow(
      'Campaign 1 was already deleted; deleting a failed campaign settles its vault box',
    )
    expect(withSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a successful campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')

    await expect(runSettleOpen(options({ command: 'settle-open' }))).rejects.toThrow(
      'Campaign 1 reached its goal; there is nothing to settle',
    )
    expect(withSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a campaign without a vault box', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(undefined)

    await expect(runSettleOpen(options({ command: 'settle-open' }))).rejects.toThrow(
      'Campaign 1 has no vault box; there is nothing to settle',
    )
    expect(withSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a box that is already settled', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_FAILED))

    await expect(runSettleOpen(options({ command: 'settle-open' }))).rejects.toThrow('Campaign 1 is already settled; backers can refund it')
    expect(withSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a box that is not open', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_CLAIMED))

    await expect(runSettleOpen(options({ command: 'settle-open' }))).rejects.toThrow(
      'Campaign 1 was not failed; there is nothing to settle',
    )
    expect(withSessionMock).not.toHaveBeenCalled()
  })

  it('propagates a failed settlement', async () => {
    sdkMocks.settleOpen.mockRejectedValue(new Error('rejected'))

    await expect(runSettleOpen(options({ command: 'settle-open' }))).rejects.toThrow('rejected')
    expect(withSessionMock).toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(runSettleOpen({ command: 'settle-open', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'settle-open requires exactly one app id',
    )
  })
})
