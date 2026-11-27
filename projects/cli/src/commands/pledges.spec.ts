import type * as Sdk from '@kasakame/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPledges } from './pledges.js'
import { HEADER, VALID_ADDRESS, WALLET, leaf, options } from './test-fixtures.js'

const sdkMocks = vi.hoisted(() => ({
  enumerateCampaigns: vi.fn(),
  fetchCampaignHeader: vi.fn(),
  fetchChainTimestamp: vi.fn(),
  getCampaignStatus: vi.fn(),
  fetchMyLeaves: vi.fn(),
}))
const whoamiMock = vi.hoisted(() => vi.fn())
const mnemonicSessionMock = vi.hoisted(() => vi.fn())

vi.mock('@kasakame/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof Sdk>()
  return {
    ...sdkMocks,
    SdkError: actual.SdkError,
    classifyChainError: actual.classifyChainError,
  }
})
vi.mock('../auth/wallet/index.js', () => ({ whoami: whoamiMock }))
vi.mock('../auth/mnemonic/index.js', () => ({ mnemonicSession: mnemonicSessionMock }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  sdkMocks.enumerateCampaigns.mockResolvedValue(new Set([1n]))
  sdkMocks.fetchCampaignHeader.mockResolvedValue(HEADER)
  sdkMocks.fetchChainTimestamp.mockResolvedValue(2_000n)
  sdkMocks.getCampaignStatus.mockReturnValue('open')
  sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_500_000n)])
  mnemonicSessionMock.mockResolvedValue(WALLET)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runPledges', () => {
  it('lists a live pledge with the withdraw action', async () => {
    expect(await runPledges(options({ command: 'pledges' }))).toBe(0)

    expect(console.error).toHaveBeenCalledWith('Searching testnet for live pledges by BACKER…')
    expect(console.log).toHaveBeenCalledWith('Live pledges by BACKER on testnet:')
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^app id\s+title\s+status\s+deadline\s+pledge\s+amount\s+action$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+open\s+1970-01-01 00:16 UTC\s+0\s+1\.5 ALGO\s+withdraw$/))
  })

  it('lists every pledge with the same format', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 500_000n), leaf(3, 1_000_000n)])

    expect(await runPledges(options({ command: 'pledges' }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Title\s+open\s+1970-01-01 00:16 UTC\s+0\s+0\.5 ALGO\s+withdraw --pledge 0$/),
    )
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Title\s+open\s+1970-01-01 00:16 UTC\s+3\s+1 ALGO\s+withdraw --pledge 3$/),
    )
    expect(console.log).toHaveBeenCalledWith('Use --all to act on every pledge.')
  })

  it('lists a failed pledge with the refund action', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')

    expect(await runPledges(options({ command: 'pledges' }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+failed\s+1970-01-01 00:16 UTC\s+0\s+1\.5 ALGO\s+refund$/))
  })

  it('marks each refundable pledge when several are live', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 500_000n), leaf(3, 1_000_000n)])

    expect(await runPledges(options({ command: 'pledges' }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Title\s+failed\s+1970-01-01 00:16 UTC\s+0\s+0\.5 ALGO\s+refund --pledge 0$/),
    )
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Title\s+failed\s+1970-01-01 00:16 UTC\s+3\s+1 ALGO\s+refund --pledge 3$/),
    )
  })

  it('keeps every successful pledge visible with no action', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 500_000n), leaf(3, 1_000_000n)])

    expect(await runPledges(options({ command: 'pledges' }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+successful\s+1970-01-01 00:16 UTC\s+0\s+0\.5 ALGO\s+-$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+successful\s+1970-01-01 00:16 UTC\s+3\s+1 ALGO\s+-$/))
  })

  it('lists a successful pledge with nothing to do', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')

    expect(await runPledges(options({ command: 'pledges' }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+successful\s+1970-01-01 00:16 UTC\s+0\s+1\.5 ALGO\s+-$/))
  })

  it('keeps a deleted pledge visible with the refund window closed', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, deleted: true })

    expect(await runPledges(options({ command: 'pledges' }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Title\s+open, deleted\s+1970-01-01 00:16 UTC\s+0\s+1\.5 ALGO\s+window closed$/),
    )
  })

  it('keeps a deleted pledge refundable while its box is open', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, deleted: true })
    sdkMocks.getCampaignStatus.mockReturnValue('failed')

    expect(await runPledges(options({ command: 'pledges' }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Title\s+failed, deleted\s+1970-01-01 00:16 UTC\s+0\s+1\.5 ALGO\s+refund$/),
    )
  })

  it('reports no live pledges', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([])

    expect(await runPledges(options({ command: 'pledges' }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith('No live pledges by BACKER on testnet.')
  })

  it('shows a state-only view for an explicit address', async () => {
    expect(await runPledges(options({ command: 'pledges', address: VALID_ADDRESS }))).toBe(0)

    expect(mnemonicSessionMock).not.toHaveBeenCalled()
    expect(whoamiMock).not.toHaveBeenCalled()
    expect(sdkMocks.fetchMyLeaves).toHaveBeenCalledWith(1n, VALID_ADDRESS)
    expect(console.log).toHaveBeenCalledWith("Read-only view; withdraw and refund need the pledge owner's wallet.")
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^app id\s+title\s+status\s+deadline\s+pledge\s+amount$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+open\s+1970-01-01 00:16 UTC\s+0\s+1\.5 ALGO$/))
    expect(console.log).not.toHaveBeenCalledWith(expect.stringMatching(/\swithdraw$/))
  })

  it('hides pledge actions in a read-only view with several pledges', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 500_000n), leaf(3, 1_000_000n)])

    expect(await runPledges(options({ command: 'pledges', address: VALID_ADDRESS }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+open\s+1970-01-01 00:16 UTC\s+0\s+0\.5 ALGO$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+open\s+1970-01-01 00:16 UTC\s+3\s+1 ALGO$/))
    expect(console.log).not.toHaveBeenCalledWith('Use --all to act on every pledge.')
  })

  it('rejects an invalid address', async () => {
    await expect(runPledges(options({ command: 'pledges', address: 'ADDRESS' }))).rejects.toThrow('Invalid address: ADDRESS')
  })

  it('reads the address from the stored wallet session', async () => {
    whoamiMock.mockResolvedValue({ address: 'WALLET_ADDRESS' })

    expect(await runPledges(options({ command: 'pledges', signer: 'wallet' }))).toBe(0)

    expect(mnemonicSessionMock).not.toHaveBeenCalled()
    expect(sdkMocks.fetchMyLeaves).toHaveBeenCalledWith(1n, 'WALLET_ADDRESS')
  })

  it('requires a wallet session or an address', async () => {
    whoamiMock.mockResolvedValue(undefined)

    await expect(runPledges(options({ command: 'pledges', signer: 'wallet' }))).rejects.toThrow(
      'No active wallet session. Run `kasakame login` first, or pass --address',
    )
  })

  it('wraps indexer failures', async () => {
    sdkMocks.enumerateCampaigns.mockRejectedValue(new Error('indexer down'))

    await expect(runPledges(options({ command: 'pledges' }))).rejects.toThrow('Could not read pledges from the indexer: indexer down')
  })
})
