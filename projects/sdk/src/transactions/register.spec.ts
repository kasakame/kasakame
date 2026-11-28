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

describe('registerCampaign', () => {
  it('registerCampaign retries registration and tolerates an already-registered campaign', async () => {
    await transactions.registerCampaign(9n, fixtures.session)
    expect(fixtures.sendRegisterMock).toHaveBeenCalledOnce()
    expect(fixtures.waitForIndexerCatchUpMock).toHaveBeenCalledOnce()

    fixtures.sendRegisterMock.mockRejectedValueOnce(new Error('campaign already registered'))
    await expect(transactions.registerCampaign(9n, fixtures.session)).resolves.toEqual({ txIds: [] })
    expect(fixtures.sendRegisterMock).toHaveBeenCalledTimes(2)
    expect(fixtures.loggerMock.debug).toHaveBeenCalledWith('register.already-registered', { appId: '9' })
    expect(fixtures.loggerMock.warn).not.toHaveBeenCalled()
  })

  it('registerCampaign surfaces other registration failures', async () => {
    fixtures.sendRegisterMock.mockRejectedValueOnce(new Error('not an official kasakame campaign'))

    await expect(transactions.registerCampaign(9n, fixtures.session)).rejects.toThrow('not an official kasakame campaign')
    expect(fixtures.waitForIndexerCatchUpMock).not.toHaveBeenCalled()
    expect(fixtures.loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'registerCampaign',
      appId: '9',
      type: 'chain-state',
      code: 'not-an-official-kasakame-campaign',
    })
  })

  it('registerCampaign is a no-op when no registry is configured', async () => {
    fixtures.registryAppIdMock.mockReturnValue(0n)

    await transactions.registerCampaign(9n, fixtures.session)

    expect(fixtures.sendRegisterMock).not.toHaveBeenCalled()
    expect(fixtures.waitForIndexerCatchUpMock).not.toHaveBeenCalled()
    expect(fixtures.loggerMock.info).not.toHaveBeenCalled()
  })
})
