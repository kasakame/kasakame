import type * as Sdk from '@kasakame/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCampaigns } from './campaigns.js'
import { HEADER, VALID_ADDRESS, WALLET, options } from './test-fixtures.js'

const sdkMocks = vi.hoisted(() => ({
  enumerateCampaigns: vi.fn(),
  fetchCampaignHeader: vi.fn(),
  fetchChainTimestamp: vi.fn(),
  getCampaignStatus: vi.fn(),
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

function header(overrides: Record<string, unknown>) {
  return { ...HEADER, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  sdkMocks.enumerateCampaigns.mockResolvedValue(new Set([1n]))
  sdkMocks.fetchCampaignHeader.mockResolvedValue(HEADER)
  sdkMocks.fetchChainTimestamp.mockResolvedValue(2_000n)
  sdkMocks.getCampaignStatus.mockReturnValue('open')
  mnemonicSessionMock.mockResolvedValue(WALLET)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runCampaigns', () => {
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

    expect(await runCampaigns(options({ command: 'campaigns' }))).toBe(0)

    expect(console.error).toHaveBeenCalledWith('Searching testnet for campaigns created by BACKER…')
    expect(console.log).toHaveBeenCalledWith('Campaigns created by BACKER on testnet:')
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^app id\s+title\s+status\s+raised \/ goal\s+deadline\s+action$/))
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Claimed\s+successful \(claimed\)\s+10 \/ 10 ALGO\s+1970-01-01 00:16 UTC\s+delete$/),
    )
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^2\s+Funded\s+successful\s+10 \/ 10 ALGO\s+1970-01-01 00:16 UTC\s+claim$/),
    )
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^3\s+Failed\s+failed\s+2 \/ 5 ALGO\s+1970-01-01 00:16 UTC\s+delete$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^4\s+Empty\s+open\s+0 \/ 10 ALGO\s+1970-01-01 00:16 UTC\s+delete$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^5\s+Live\s+open\s+2 \/ 10 ALGO\s+1970-01-01 00:16 UTC\s+-$/))
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^6\s+Gone\s+failed, deleted\s+2 \/ 10 ALGO\s+1970-01-01 00:16 UTC\s+-$/),
    )
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Other'))
  })

  it('reports no campaigns for the address', async () => {
    sdkMocks.enumerateCampaigns.mockResolvedValue(new Set())

    expect(await runCampaigns(options({ command: 'campaigns' }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith('No campaigns created by BACKER on testnet.')
  })

  it('hides creator actions in a read-only view', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue(header({ creator: VALID_ADDRESS, raisedMicroAlgos: 0n }))

    expect(await runCampaigns(options({ command: 'campaigns', address: VALID_ADDRESS }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith("Read-only view; claim and delete need the creator's wallet.")
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^app id\s+title\s+status\s+raised \/ goal\s+deadline$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+open\s+0 \/ 10 ALGO\s+1970-01-01 00:16 UTC$/))
    expect(console.log).not.toHaveBeenCalledWith(expect.stringMatching(/\sdelete$/))
  })

  it('skips ids the indexer does not know', async () => {
    sdkMocks.enumerateCampaigns.mockResolvedValue(new Set([1n, 2n, 3n]))
    sdkMocks.fetchCampaignHeader.mockImplementation((id: bigint) => {
      if (id === 1n) return header({ creator: 'BACKER', raisedMicroAlgos: 0n })
      if (id === 2n) return undefined
      throw new Error('no application found for application-id: 3')
    })

    expect(await runCampaigns(options({ command: 'campaigns' }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith('Campaigns created by BACKER on testnet:')
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+open\s+0 \/ 10 ALGO\s+1970-01-01 00:16 UTC\s+delete$/))
  })

  it('wraps indexer failures', async () => {
    sdkMocks.fetchCampaignHeader.mockRejectedValue(new Error('indexer down'))

    await expect(runCampaigns(options({ command: 'campaigns' }))).rejects.toThrow('Could not read campaigns from the indexer: indexer down')
  })
})
