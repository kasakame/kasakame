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

describe('permissionless cleanup', () => {
  it('settleOpen settles a failed campaign permissionlessly', async () => {
    await transactions.settleOpen(9n, fixtures.session)

    expect(fixtures.setSignerMock).toHaveBeenCalledWith('ADDRESS', fixtures.session.signer)
    const call = fixtures.sendSettleOpenMock.mock.calls[0]?.[0] as {
      args: { app: bigint }
      sender: string
      appReferences: unknown[]
      boxReferences: unknown[]
    }
    expect(call.args.app).toEqual(9n)
    expect(call.sender).toEqual(fixtures.session.address)
    expect(call.appReferences).toEqual([9n])
    expect(call.boxReferences).toHaveLength(1)
    expect(fixtures.waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
  })

  it('releaseClaimed releases a claimed box permissionlessly', async () => {
    await transactions.releaseClaimed(9n, fixtures.session)

    expect(fixtures.setSignerMock).toHaveBeenCalledWith('ADDRESS', fixtures.session.signer)
    const call = fixtures.sendReleaseClaimedMock.mock.calls[0]?.[0] as { args: { app: bigint }; boxReferences: unknown[] }
    expect(call.args.app).toEqual(9n)
    expect(call.boxReferences).toHaveLength(1)
    expect(fixtures.waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
  })

  it('finalize funds the residual inner payment', async () => {
    fixtures.campaignBoxValueMock.mockResolvedValue(fixtures.vaultBox(500n, 200n))

    await transactions.finalize(9n, fixtures.session)

    expect(fixtures.setSignerMock).toHaveBeenCalledWith('ADDRESS', fixtures.session.signer)
    const call = fixtures.sendFinalizeMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(call.extraFee.microAlgo).toEqual(1_000n)
    expect(fixtures.waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
  })

  it('finalize skips the inner fee when the box is fully paid out', async () => {
    fixtures.campaignBoxValueMock.mockResolvedValue(fixtures.vaultBox(500n, 500n))

    await transactions.finalize(9n, fixtures.session)

    const call = fixtures.sendFinalizeMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(call.extraFee.microAlgo).toEqual(0n)
  })

  it('finalize skips the inner fee when the box is missing', async () => {
    fixtures.campaignBoxValueMock.mockRejectedValue(new Error('box not found'))

    await transactions.finalize(9n, fixtures.session)

    const call = fixtures.sendFinalizeMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(call.extraFee.microAlgo).toEqual(0n)
  })

  it('finalize propagates a non-404 box read error', async () => {
    fixtures.campaignBoxValueMock.mockRejectedValue(new Error('timeout'))

    await expect(transactions.finalize(9n, fixtures.session)).rejects.toThrow('timeout')
    expect(fixtures.sendFinalizeMock).not.toHaveBeenCalled()
  })

  it('surfaces a cleanup rejection without waiting for the indexer', async () => {
    fixtures.sendFinalizeMock.mockRejectedValueOnce(new Error('refund window still open'))

    await expect(transactions.finalize(9n, fixtures.session)).rejects.toThrow('refund window still open')
    expect(fixtures.waitForIndexerCatchUpMock).not.toHaveBeenCalled()
    expect(fixtures.loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'finalize',
      appId: '9',
      type: 'chain-state',
      code: 'refund-window-open',
    })
  })
})
