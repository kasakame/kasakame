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

describe('refund', () => {
  it('refund routes through the campaign while the box is open', async () => {
    fixtures.campaignBoxValueMock.mockResolvedValue(new Uint8Array(65).fill(1))
    await transactions.refund(9n, fixtures.session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(fixtures.setSignerMock).toHaveBeenCalledWith('ADDRESS', fixtures.session.signer)
    expect(fixtures.paramsCampaignRefundMock).toHaveBeenCalledOnce()
    expect(fixtures.paramsVaultRefundMock).not.toHaveBeenCalled()
    expect(fixtures.composerSendMock).toHaveBeenCalledOnce()
    expect(fixtures.loggerMock.debug).toHaveBeenCalledWith('refund.route', { appId: '9', route: 'campaign' })
  })

  it('scales the refund fee with the tree size', async () => {
    fixtures.loadTreeMock.mockResolvedValue({ leaves: Array.from({ length: 100 }, () => new Uint8Array(32)), raised: 0n })
    fixtures.campaignBoxValueMock.mockResolvedValue(new Uint8Array(65).fill(1))
    await transactions.refundGroup(9n, fixtures.session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    const call = fixtures.paramsCampaignRefundMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(call.extraFee.microAlgo).toEqual(7_000n)
  })

  it('refund routes straight to the vault once settled', async () => {
    const box = new Uint8Array(65)
    box[56] = 2
    fixtures.campaignBoxValueMock.mockResolvedValue(box)
    await transactions.refund(9n, fixtures.session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(fixtures.setSignerMock).toHaveBeenCalledWith('ADDRESS', fixtures.session.signer)
    expect(fixtures.paramsVaultRefundMock).toHaveBeenCalledOnce()
    expect(fixtures.paramsCampaignRefundMock).not.toHaveBeenCalled()
    expect(fixtures.loggerMock.debug).toHaveBeenCalledWith('refund.route', { appId: '9', route: 'vault' })
    const call = fixtures.paramsVaultRefundMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(call.extraFee.microAlgo).toEqual(3_000n)
  })

  it('refund routes through the campaign when no box exists yet', async () => {
    fixtures.campaignBoxValueMock.mockRejectedValue(new Error('box not found'))
    await transactions.refund(9n, fixtures.session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(fixtures.paramsCampaignRefundMock).toHaveBeenCalledOnce()
  })

  it('refund propagates a non-404 box read error', async () => {
    fixtures.campaignBoxValueMock.mockRejectedValue(new Error('timeout'))

    await expect(transactions.refund(9n, fixtures.session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })).rejects.toThrow(
      'timeout',
    )
    expect(fixtures.paramsCampaignRefundMock).not.toHaveBeenCalled()
    expect(fixtures.paramsVaultRefundMock).not.toHaveBeenCalled()
  })

  it('refundGroup returns the built transactions without a group id and without sending', async () => {
    fixtures.campaignBoxValueMock.mockResolvedValue(new Uint8Array(65).fill(1))
    const built = [{ txn: { group: new Uint8Array(32) }, signer: 'signer' }]
    fixtures.composerBuildMock.mockResolvedValue({ transactions: built })

    const group = await transactions.refundGroup(9n, fixtures.session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })
    expect(group).toBe(built)
    expect(built[0]?.txn.group).toBeUndefined()
    expect(fixtures.paramsCampaignRefundMock).toHaveBeenCalledOnce()
    expect(fixtures.composerSendMock).not.toHaveBeenCalled()
  })

  it('refund retries through the vault when the campaign settles mid-send', async () => {
    fixtures.campaignBoxValueMock
      .mockResolvedValueOnce(fixtures.vaultBox(500n, 0n, 1))
      .mockResolvedValueOnce(fixtures.vaultBox(500n, 0n, 2))
    fixtures.composerSendMock
      .mockRejectedValueOnce(new Error('campaign is not open'))
      .mockResolvedValueOnce({ confirmations: [{ confirmedRound: 99n }] })

    await transactions.refund(9n, fixtures.session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(fixtures.paramsCampaignRefundMock).toHaveBeenCalledOnce()
    expect(fixtures.paramsVaultRefundMock).toHaveBeenCalledOnce()
    expect(fixtures.campaignBoxValueMock).toHaveBeenCalledTimes(2)
    expect(fixtures.waitForIndexerRoundMock).toHaveBeenCalledWith(99n)
    expect(fixtures.loggerMock.debug).toHaveBeenCalledWith('refund.reroute', {
      appId: '9',
      type: 'routing',
      code: 'campaign-not-open',
    })
    expect(fixtures.loggerMock.warn).not.toHaveBeenCalled()
  })

  it('refund retries through the vault when the campaign app disappears mid-send', async () => {
    fixtures.campaignBoxValueMock
      .mockResolvedValueOnce(fixtures.vaultBox(500n, 0n, 1))
      .mockResolvedValueOnce(fixtures.vaultBox(500n, 0n, 2))
    fixtures.composerSendMock
      .mockRejectedValueOnce(new Error('application 123 not found'))
      .mockResolvedValueOnce({ confirmations: [{ confirmedRound: 99n }] })

    await transactions.refund(9n, fixtures.session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(fixtures.paramsCampaignRefundMock).toHaveBeenCalledOnce()
    expect(fixtures.paramsVaultRefundMock).toHaveBeenCalledOnce()
  })

  it('refund surfaces a second routing failure', async () => {
    fixtures.campaignBoxValueMock.mockResolvedValue(fixtures.vaultBox(500n, 0n, 1))
    fixtures.composerSendMock.mockRejectedValue(new Error('campaign is not open'))

    await expect(transactions.refund(9n, fixtures.session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })).rejects.toThrow(
      'campaign is not open',
    )
    expect(fixtures.composerSendMock).toHaveBeenCalledTimes(2)
    expect(fixtures.loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'refund',
      appId: '9',
      type: 'routing',
      code: 'campaign-not-open',
    })
  })

  it('refund does not retry a non-routing failure', async () => {
    fixtures.campaignBoxValueMock.mockResolvedValue(fixtures.vaultBox(500n, 0n, 2))
    fixtures.composerSendMock.mockRejectedValueOnce(new Error('campaign is not refundable'))

    await expect(transactions.refund(9n, fixtures.session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })).rejects.toThrow(
      'campaign is not refundable',
    )
    expect(fixtures.composerSendMock).toHaveBeenCalledOnce()
  })
})
