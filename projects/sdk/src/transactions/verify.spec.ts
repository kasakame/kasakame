import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClaimTree from '../claim-tree/index.js'
import { SPECS_VERSION } from '../index.js'
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

describe('verifyDeployment', () => {
  it('verifyDeployment accepts a Registry with the matching Campaign hash', async () => {
    await expect(transactions.verifyDeployment()).resolves.toBeUndefined()
  })

  it('verifyDeployment rejects a Registry with another Campaign hash', async () => {
    fixtures.campaignProgramHashMock.mockReturnValue(new Uint8Array(32).fill(7))

    await expect(transactions.verifyDeployment()).rejects.toThrow(
      `the Registry expects Campaign program hash ${'07'.repeat(32)}, but this SDK ships contracts ${SPECS_VERSION}`,
    )
    expect(fixtures.loggerMock.error).toHaveBeenCalledWith('operation.failed', {
      operation: 'verifyDeployment',
      appId: '1001',
      type: 'registry-mismatch',
    })
  })

  it('verifyDeployment treats a missing Registry hash as a mismatch', async () => {
    fixtures.campaignProgramHashMock.mockReturnValue(undefined)

    await expect(transactions.verifyDeployment()).rejects.toThrow(/Campaign program hash missing/)
  })

  it('verifyDeployment wraps Registry read failures', async () => {
    fixtures.campaignProgramHashMock.mockRejectedValueOnce(new Error('registry unreachable'))

    await expect(transactions.verifyDeployment()).rejects.toThrow('could not read the Registry campaign program hash: registry unreachable')
  })

  it('verifyDeployment classifies a read failure that carries a contract assert', async () => {
    fixtures.campaignProgramHashMock.mockRejectedValueOnce(new Error('campaign is not open'))

    const error = await transactions.verifyDeployment().catch((caught: unknown) => caught)
    expect(error).toMatchObject({ type: 'routing', code: 'campaign-not-open' })
    expect((error as Error).message).toContain('could not read the Registry campaign program hash:')
  })

  it('verifyDeployment stringifies a non-Error Registry failure', async () => {
    fixtures.campaignProgramHashMock.mockRejectedValueOnce('offline')

    await expect(transactions.verifyDeployment()).rejects.toThrow('could not read the Registry campaign program hash: offline')
  })

  it('verifyDeployment rejects a spec without bytecode', async () => {
    delete fixtures.appSpecMock.byteCode

    await expect(transactions.verifyDeployment()).rejects.toThrow(/no byteCode/)
  })

  it('verifyDeployment no-ops without a Registry', async () => {
    fixtures.registryAppIdMock.mockReturnValue(0n)

    await expect(transactions.verifyDeployment()).resolves.toBeUndefined()
    expect(fixtures.campaignProgramHashMock).not.toHaveBeenCalled()
  })
})
