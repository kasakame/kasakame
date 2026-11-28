import * as constants from '@kasakame/constants'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ClaimTree from '../claim-tree/index.js'
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

describe('pledge and cancel', () => {
  it('pledge submits one atomic [pay, pledge, credit] group with a fresh frontier', async () => {
    await transactions.pledge(9n, fixtures.session, 1_000_000n)

    expect(fixtures.setSignerMock).toHaveBeenCalledWith('ADDRESS', fixtures.session.signer)
    expect(fixtures.loadTreeMock).toHaveBeenCalledOnce()
    expect(fixtures.frontierMock).toHaveBeenCalledOnce()
    expect(fixtures.paramsPledgeMock).toHaveBeenCalledOnce()
    expect(fixtures.paramsCreditMock).toHaveBeenCalledOnce()
    // Two app calls in one group (the payment rides along as the transactions.pledge's txn arg).
    expect(fixtures.composerAddMock).toHaveBeenCalledTimes(2)
    expect(fixtures.composerSendMock).toHaveBeenCalledOnce()
    // Once before building proofs (fresh tree on the first attempt), once after for UI refresh.
    expect(fixtures.waitForIndexerCatchUpMock).toHaveBeenCalledTimes(2)
  })

  it('pledge keeps a confirmed write successful when the post-send indexer wait fails', async () => {
    fixtures.waitForIndexerCatchUpMock.mockReset()
    fixtures.waitForIndexerCatchUpMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('algod unreachable'))

    const result = await transactions.pledge(9n, fixtures.session, 1_000_000n)
    expect(result).toEqual({ txIds: ['GROUP'], confirmedRound: 99n, position: 4, amount: 1_000_000n })
    expect(fixtures.composerSendMock).toHaveBeenCalledOnce()
    expect(fixtures.waitForIndexerCatchUpMock).toHaveBeenCalledTimes(2)
    expect(fixtures.loggerMock.info).toHaveBeenCalledWith('write.confirmed', {
      operation: 'pledge',
      appId: '9',
      txIds: ['GROUP'],
      confirmedRound: '99',
      position: 4,
      amount: '1000000',
    })
  })

  it('logs a write confirmation without a round when the node omits it', async () => {
    fixtures.composerSendMock.mockResolvedValueOnce({ txIds: ['GROUP'] })

    await transactions.pledge(9n, fixtures.session, 1_000_000n)

    expect(fixtures.loggerMock.info).toHaveBeenCalledWith('write.confirmed', {
      operation: 'pledge',
      appId: '9',
      txIds: ['GROUP'],
      position: 4,
      amount: '1000000',
    })
  })

  it('pledge rejects amounts outside the contract bounds before building', async () => {
    await expect(transactions.pledge(9n, fixtures.session, constants.MIN_PLEDGE_MICRO_ALGOS - 1n)).rejects.toThrow(
      /pledge amount must be between/,
    )
    await expect(transactions.pledge(9n, fixtures.session, constants.MAX_PLEDGE_MICRO_ALGOS + 1n)).rejects.toThrow(
      /pledge amount must be between/,
    )
    expect(fixtures.loadTreeMock).not.toHaveBeenCalled()
    expect(fixtures.paramsPledgeMock).not.toHaveBeenCalled()
    expect(fixtures.paymentMock).not.toHaveBeenCalled()
    expect(fixtures.loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'pledge',
      appId: '9',
      type: 'validation',
    })
    expect(fixtures.loggerMock.warn).toHaveBeenCalledTimes(2)
  })

  it('pledge accepts the inclusive amount bounds', async () => {
    await transactions.pledge(9n, fixtures.session, constants.MIN_PLEDGE_MICRO_ALGOS)
    await transactions.pledge(9n, fixtures.session, constants.MAX_PLEDGE_MICRO_ALGOS)
    expect(fixtures.composerSendMock).toHaveBeenCalledTimes(2)
  })

  it('pledgeGroup returns the built transactions without a group id and without sending', async () => {
    const built = [{ txn: { group: new Uint8Array(32) }, signer: 'signer' }]
    fixtures.composerBuildMock.mockResolvedValue({ transactions: built })

    const group = await transactions.pledgeGroup(9n, fixtures.session, 1_000_000n)
    expect(group).toBe(built)
    expect(built[0]?.txn.group).toBeUndefined()
    expect(fixtures.composerAddMock).toHaveBeenCalledTimes(2)
    expect(fixtures.composerBuildMock).toHaveBeenCalledOnce()
    expect(fixtures.composerSendMock).not.toHaveBeenCalled()
    expect(fixtures.setSignerMock).toHaveBeenCalledWith('ADDRESS', fixtures.session.signer)
  })

  it('scales the pledge fee with the tree size', async () => {
    fixtures.loadTreeMock.mockResolvedValue({ leaves: Array.from({ length: 15 }, () => new Uint8Array(32)), raised: 0n })
    await transactions.pledgeGroup(9n, fixtures.session, 1_000_000n)

    const call = fixtures.paramsPledgeMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(call.extraFee.microAlgo).toEqual(1_000n)
  })

  it('rejects a pledge at the maximum tree size', async () => {
    fixtures.loadTreeMock.mockResolvedValue({ leaves: { length: Number(ClaimTree.MAX_TREE_SIZE) }, raised: 0n })
    const error = await transactions.pledgeGroup(9n, fixtures.session, 1_000_000n).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(transactions.SdkError)
    expect(error).toMatchObject({ type: 'chain-state', code: 'campaign-max-size', operation: 'pledge', appId: 9n })
    expect((error as Error).message).toContain('maximum size')
  })

  it('pledge retries once on a stale frontier, then throws', async () => {
    fixtures.composerSendMock.mockRejectedValueOnce(new Error('stale or forged frontier')).mockResolvedValueOnce({})
    await transactions.pledge(9n, fixtures.session, 1_000_000n)
    expect(fixtures.loadTreeMock).toHaveBeenCalledTimes(2)
    expect(fixtures.loggerMock.debug).toHaveBeenCalledWith('stale-proof.retry', { operation: 'pledge', appId: '9' })

    fixtures.composerSendMock
      .mockRejectedValueOnce(new Error('stale or forged frontier'))
      .mockRejectedValueOnce(new Error('stale or forged frontier'))
    await expect(transactions.pledge(9n, fixtures.session, 1_000_000n)).rejects.toThrow('stale or forged frontier')
    expect(fixtures.loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'pledge',
      appId: '9',
      type: 'stale-proof',
      code: 'stale-proof',
    })

    fixtures.composerSendMock.mockRejectedValueOnce(new Error('boom'))
    await expect(transactions.pledge(9n, fixtures.session, 1_000_000n)).rejects.toThrow('boom')
  })

  it('scales extra fees with the runtime minimum fee', async () => {
    fixtures.getSuggestedParamsMock.mockResolvedValue({ minFee: 1_200n })

    await transactions.claim(9n, fixtures.session)
    const claimCall = fixtures.sendClaimMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(claimCall.extraFee.microAlgo).toEqual(2_400n)

    await transactions.deleteCampaign(9n, fixtures.session)
    const unregisterCall = fixtures.paramsUnregisterMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    const deleteCall = fixtures.paramsPledgeMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(unregisterCall.extraFee.microAlgo).toEqual(1_200n)
    expect(deleteCall.extraFee.microAlgo).toEqual(2_400n)
  })

  it('cancelPledge spends one leaf with a fresh path', async () => {
    await transactions.cancelPledge(9n, fixtures.session, { position: 2, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(fixtures.setSignerMock).toHaveBeenCalledWith('ADDRESS', fixtures.session.signer)
    expect(fixtures.pathBlobMock).toHaveBeenCalledOnce()
    expect(fixtures.sendCancelPledgeMock).toHaveBeenCalledOnce()
    const call = fixtures.sendCancelPledgeMock.mock.calls[0]?.[0] as {
      args: { k: number; amount: bigint }
      extraFee: { microAlgo: bigint }
      boxReferences: unknown[]
    }
    expect(call.args.k).toEqual(2)
    expect(call.args.amount).toEqual(1_000_000n)
    expect(call.extraFee.microAlgo).toEqual(4_000n)
    expect(call.boxReferences).toHaveLength(1)
    expect(fixtures.waitForIndexerRoundMock).toHaveBeenCalledWith(99n)
  })

  it('cancelPledge logs and throws a final failure', async () => {
    fixtures.sendCancelPledgeMock.mockRejectedValueOnce(new Error('pledging is closed'))

    await expect(
      transactions.cancelPledge(9n, fixtures.session, { position: 2, amount: 1_000_000n, txidHex: 'ab'.repeat(32) }),
    ).rejects.toThrow('pledging is closed')
    expect(fixtures.loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'cancelPledge',
      appId: '9',
      type: 'chain-state',
      code: 'pledging-closed',
    })
  })
})
