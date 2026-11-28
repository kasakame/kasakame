import * as constants from '@kasakame/constants'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClaimTree from '../claim-tree/index.js'
import * as transactions from './index.js'
import * as fixtures from './test-fixtures.js'

vi.mock('../runtime/log.js', async () => (await import('./test-fixtures.js')).runtimeLogModule)
vi.mock('../generated/CampaignClient.js', async () => (await import('./test-fixtures.js')).campaignClientModule)
vi.mock('../generated/ClaimsVaultClient.js', async () => (await import('./test-fixtures.js')).vaultClientModule)
vi.mock('../generated/RegistryClient.js', async () => (await import('./test-fixtures.js')).registryClientModule)
vi.mock('../runtime/config.js', async () => (await import('./test-fixtures.js')).runtimeConfigModule)
vi.mock('../runtime/indexer.js', async () => (await import('./test-fixtures.js')).runtimeIndexerModule)
vi.mock('../runtime/clock.js', async () => (await import('./test-fixtures.js')).runtimeClockModule)
vi.mock('../claim-tree/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaimTree>()
  const { clearTreeCacheMock, loadTreeMock, frontierMock, pathBlobMock } = await import('./test-fixtures.js')
  return {
    ...actual,
    clearTreeCache: (...args: unknown[]) => clearTreeCacheMock(...args),
    loadTree: (...args: unknown[]) => loadTreeMock(...args),
    frontierForPledge: (...args: unknown[]) => frontierMock(...args),
    pathBlobForRefund: (...args: unknown[]) => pathBlobMock(...args),
  }
})

beforeEach(fixtures.resetMocks)

describe('createCampaign', () => {
  it('createCampaign runs create then register (nothing funded)', async () => {
    const result = await transactions.createCampaign(
      fixtures.session,
      'Title',
      'ipfs://meta',
      1_000_000n,
      BigInt(constants.MIN_CAMPAIGN_DURATION_SECONDS),
    )
    expect(result).toEqual({
      txIds: ['CREATE'],
      confirmedRound: 99n,
      appId: 9n,
      appAddress: 'ESCROW',
      registered: true,
      registerTxIds: ['CLIENT'],
    })
    expect(fixtures.sendCreateMock).toHaveBeenCalledOnce()
    expect(fixtures.sendRegisterMock).toHaveBeenCalledOnce()
    expect(fixtures.waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
    expect(fixtures.loggerMock.info).toHaveBeenCalledWith('write.confirmed', {
      operation: 'createCampaign',
      appId: '9',
      txIds: ['CREATE'],
      confirmedRound: '99',
    })
  })

  it('createCampaign returns the app id when the post-send indexer wait fails', async () => {
    fixtures.waitForIndexerCatchUpMock.mockRejectedValueOnce(new Error('indexer unreachable'))

    const result = await transactions.createCampaign(
      fixtures.session,
      'Title',
      'ipfs://meta',
      1_000_000n,
      BigInt(constants.MIN_CAMPAIGN_DURATION_SECONDS),
    )

    expect(result).toEqual({
      txIds: ['CREATE'],
      confirmedRound: 99n,
      appId: 9n,
      appAddress: 'ESCROW',
      registered: true,
      registerTxIds: ['CLIENT'],
    })
    expect(fixtures.waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
  })

  it('returns the app id when registration fails', async () => {
    fixtures.sendRegisterMock.mockRejectedValueOnce(new Error('not an official kasakame campaign'))

    const result = await transactions.createCampaign(
      fixtures.session,
      'Title',
      'ipfs://meta',
      1_000_000n,
      BigInt(constants.MIN_CAMPAIGN_DURATION_SECONDS),
    )

    expect(result).toEqual({
      txIds: ['CREATE'],
      confirmedRound: 99n,
      appId: 9n,
      appAddress: 'ESCROW',
      registered: false,
      registerError: 'not an official kasakame campaign',
    })
    expect(fixtures.loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'registerCampaign',
      appId: '9',
      type: 'chain-state',
      code: 'not-an-official-kasakame-campaign',
    })
    expect(fixtures.waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
  })

  it('treats an already-registered race during create as registered', async () => {
    fixtures.sendRegisterMock.mockRejectedValueOnce(new Error('campaign already registered'))

    const result = await transactions.createCampaign(
      fixtures.session,
      'Title',
      'ipfs://meta',
      1_000_000n,
      BigInt(constants.MIN_CAMPAIGN_DURATION_SECONDS),
    )

    expect(result).toMatchObject({ registered: true })
    expect(result.registerError).toBeUndefined()
    expect(fixtures.loggerMock.debug).toHaveBeenCalledWith('register.already-registered', { appId: '9' })
    expect(fixtures.loggerMock.warn).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error registration failure', async () => {
    fixtures.sendRegisterMock.mockRejectedValueOnce('not an official kasakame campaign')

    const result = await transactions.createCampaign(
      fixtures.session,
      'Title',
      'ipfs://meta',
      1_000_000n,
      BigInt(constants.MIN_CAMPAIGN_DURATION_SECONDS),
    )

    expect(result.registered).toBe(false)
    expect(result.registerError).toBe('not an official kasakame campaign')
  })

  it('creates without registering when no registry is configured', async () => {
    fixtures.registryAppIdMock.mockReturnValue(0n)
    const result = await transactions.createCampaign(
      fixtures.session,
      'Title',
      'ipfs://meta',
      1_000_000n,
      BigInt(constants.MIN_CAMPAIGN_DURATION_SECONDS),
    )

    expect(result.registered).toBe(true)
    expect(fixtures.sendCreateMock).toHaveBeenCalledOnce()
    expect(fixtures.sendRegisterMock).not.toHaveBeenCalled()
  })

  it('createCampaign rejects a mismatched bundle before building create', async () => {
    fixtures.campaignProgramHashMock.mockReturnValue(new Uint8Array(32).fill(7))

    await expect(
      transactions.createCampaign(fixtures.session, 'Title', 'ipfs://meta', 1_000_000n, BigInt(constants.MIN_CAMPAIGN_DURATION_SECONDS)),
    ).rejects.toThrow(/expects Campaign program hash/)
    expect(fixtures.sendCreateMock).not.toHaveBeenCalled()
    expect(fixtures.paymentMock).not.toHaveBeenCalled()
  })

  it('createCampaign rejects inputs outside the contract bounds', async () => {
    fixtures.fetchChainTimestampMock.mockResolvedValue(1_000n)
    const minDeadline = 1_000n + BigInt(constants.MIN_CAMPAIGN_DURATION_SECONDS)
    const maxDeadline = 1_000n + BigInt(constants.MAX_CAMPAIGN_DURATION_SECONDS)
    const cases: [string, string, bigint, bigint, RegExp][] = [
      ['', 'ipfs://meta', constants.MIN_GOAL_MICRO_ALGOS, minDeadline, /title is required/],
      ['a'.repeat(constants.MAX_TITLE_BYTES + 1), 'ipfs://meta', constants.MIN_GOAL_MICRO_ALGOS, minDeadline, /title must be at most/],
      [
        'Title',
        'a'.repeat(constants.MAX_METADATA_URI_BYTES + 1),
        constants.MIN_GOAL_MICRO_ALGOS,
        minDeadline,
        /metadata URI must be at most/,
      ],
      ['Title', 'ipfs://meta', constants.MIN_GOAL_MICRO_ALGOS - 1n, minDeadline, /goal must be between/],
      ['Title', 'ipfs://meta', constants.MAX_GOAL_MICRO_ALGOS + 1n, minDeadline, /goal must be between/],
      ['Title', 'ipfs://meta', constants.MIN_GOAL_MICRO_ALGOS, minDeadline - 1n, /deadline must be between/],
      ['Title', 'ipfs://meta', constants.MIN_GOAL_MICRO_ALGOS, maxDeadline + 1n, /deadline must be between/],
    ]
    for (const [title, uri, goal, deadline, error] of cases) {
      await expect(transactions.createCampaign(fixtures.session, title, uri, goal, deadline)).rejects.toThrow(error)
    }
    expect(fixtures.sendCreateMock).not.toHaveBeenCalled()
    expect(fixtures.paymentMock).not.toHaveBeenCalled()
  })

  it('createCampaign accepts the inclusive contract bounds', async () => {
    fixtures.fetchChainTimestampMock.mockResolvedValue(1_000n)
    const title = 'a'.repeat(constants.MAX_TITLE_BYTES)
    const uri = 'a'.repeat(constants.MAX_METADATA_URI_BYTES)
    await transactions.createCampaign(
      fixtures.session,
      title,
      uri,
      constants.MIN_GOAL_MICRO_ALGOS,
      1_000n + BigInt(constants.MIN_CAMPAIGN_DURATION_SECONDS),
    )
    await transactions.createCampaign(
      fixtures.session,
      title,
      uri,
      constants.MAX_GOAL_MICRO_ALGOS,
      1_000n + BigInt(constants.MAX_CAMPAIGN_DURATION_SECONDS),
    )
    expect(fixtures.sendCreateMock).toHaveBeenCalledTimes(2)
  })
})
