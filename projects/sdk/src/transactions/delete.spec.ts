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

describe('deleteCampaign', () => {
  it('a campaign whose registration failed can still be deleted', async () => {
    fixtures.sendRegisterMock.mockRejectedValueOnce(new Error('not an official kasakame campaign'))
    const result = await transactions.createCampaign(
      fixtures.session,
      'Title',
      'ipfs://meta',
      1_000_000n,
      BigInt(constants.MIN_CAMPAIGN_DURATION_SECONDS),
    )

    await transactions.deleteCampaign(result.appId, fixtures.session)

    expect(fixtures.paramsUnregisterMock).toHaveBeenCalledOnce()
    expect(fixtures.composerAddMock).toHaveBeenCalledTimes(2)
    expect(fixtures.composerSendMock).toHaveBeenCalledOnce()
  })

  it('falls back to the vault Registry when the session has none', async () => {
    fixtures.registryAppIdMock.mockReturnValue(0n)
    fixtures.vaultRegistryMock.mockResolvedValue(1_001n)
    await transactions.deleteCampaign(9n, fixtures.session)

    expect(fixtures.registryClientIdMock).toHaveBeenCalledWith(1_001n)
    expect(fixtures.paramsUnregisterMock).toHaveBeenCalledOnce()
    expect(fixtures.composerAddMock).toHaveBeenCalledTimes(2)
    expect(fixtures.composerSendMock).toHaveBeenCalledOnce()
  })

  it('skips unregister when the vault has no Registry', async () => {
    fixtures.registryAppIdMock.mockReturnValue(0n)
    fixtures.vaultRegistryMock.mockResolvedValue(undefined)
    await transactions.deleteCampaign(9n, fixtures.session)

    expect(fixtures.composerAddMock).toHaveBeenCalledTimes(1)
    expect(fixtures.paramsUnregisterMock).not.toHaveBeenCalled()
    expect(fixtures.composerSendMock).toHaveBeenCalledOnce()
  })

  it('skips the indexer wait when confirmations carry no round', async () => {
    fixtures.composerSendMock.mockResolvedValue({ confirmations: [] })
    for (const mock of [fixtures.sendCancelPledgeMock, fixtures.sendClaimMock, fixtures.sendDeleteMock]) {
      mock.mockResolvedValue({ confirmation: {} })
    }
    fixtures.campaignBoxValueMock.mockResolvedValue(new Uint8Array(65).fill(1))

    await transactions.pledge(9n, fixtures.session, 1_000_000n)
    await transactions.cancelPledge(9n, fixtures.session, { position: 2, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })
    await transactions.refund(9n, fixtures.session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })
    await transactions.claim(9n, fixtures.session)
    await transactions.deleteCampaign(9n, fixtures.session)
    expect(fixtures.waitForIndexerRoundMock).not.toHaveBeenCalled()
  })

  it('deleteCampaign settles, closes, and unregisters in one atomic group', async () => {
    await transactions.deleteCampaign(9n, fixtures.session)

    expect(fixtures.setSignerMock).toHaveBeenCalledWith('ADDRESS', fixtures.session.signer)
    expect(fixtures.paramsUnregisterMock).toHaveBeenCalledOnce()
    expect(fixtures.paramsPledgeMock).toHaveBeenCalledOnce()
    // Unregister first (references resolve while the app exists), delete second: one group, one approval.
    expect(fixtures.composerAddMock).toHaveBeenCalledTimes(2)
    expect(fixtures.composerSendMock).toHaveBeenCalledOnce()
    expect(fixtures.waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
    expect(fixtures.sendDeleteMock).not.toHaveBeenCalled()
    expect(fixtures.sendUnregisterMock).not.toHaveBeenCalled()
  })
})
