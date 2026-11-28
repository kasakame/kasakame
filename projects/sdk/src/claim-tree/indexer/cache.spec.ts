import { beforeEach, describe, expect, it } from 'vitest'
import { clearTreeCache, fetchPledges } from '../index.js'
import { BACKER_A, CAMPAIGN, VAULT, blockMock, indexerMock, payment, pledgeCall, searchMock, setupIndexer } from './test-fixtures.js'

beforeEach(setupIndexer)

describe('tree cache', () => {
  const payA = payment('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', BACKER_A, VAULT, 3_000_000n)
  const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)

  function mockSuccessfulReplay(): void {
    indexerMock.searchForTransactions.mockImplementation(searchMock(new Map([[CAMPAIGN, [[callA]]]])))
    indexerMock.lookupBlock.mockImplementation(blockMock(new Map([[100n, [payA, callA]]])))
  }

  it('reuses downloads across repeat reads', async () => {
    mockSuccessfulReplay()

    await fetchPledges(CAMPAIGN, VAULT)
    await fetchPledges(CAMPAIGN, VAULT)
    expect(indexerMock.searchForTransactions).toHaveBeenCalledTimes(1)
    expect(indexerMock.lookupBlock).toHaveBeenCalledTimes(1)
  })

  it('refetches after clearTreeCache', async () => {
    mockSuccessfulReplay()

    await fetchPledges(CAMPAIGN, VAULT)
    clearTreeCache()
    await fetchPledges(CAMPAIGN, VAULT)
    expect(indexerMock.searchForTransactions).toHaveBeenCalledTimes(2)
    expect(indexerMock.lookupBlock).toHaveBeenCalledTimes(2)
  })

  it('does not cache failures', async () => {
    mockSuccessfulReplay()
    indexerMock.searchForTransactions.mockImplementationOnce(() => ({
      applicationID: () => ({
        limit: () => ({
          do: () => Promise.reject(new Error('offline')),
        }),
      }),
    }))

    await expect(fetchPledges(CAMPAIGN, VAULT)).rejects.toThrow('offline')
    const pledges = await fetchPledges(CAMPAIGN, VAULT)
    expect(pledges).toHaveLength(1)
    expect(indexerMock.searchForTransactions).toHaveBeenCalledTimes(2)
  })
})
