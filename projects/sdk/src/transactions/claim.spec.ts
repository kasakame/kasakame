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

describe('claim', () => {
  it('claim pays the vault-derived total', async () => {
    await transactions.claim(9n, fixtures.session)

    expect(fixtures.setSignerMock).toHaveBeenCalledWith('ADDRESS', fixtures.session.signer)
    expect(fixtures.sendClaimMock).toHaveBeenCalledOnce()
    const call = fixtures.sendClaimMock.mock.calls[0]?.[0] as { extraFee: unknown; boxReferences: unknown[] }
    expect(call.boxReferences).toHaveLength(1)
    expect(fixtures.waitForIndexerRoundMock).toHaveBeenCalledWith(99n)
  })
})
