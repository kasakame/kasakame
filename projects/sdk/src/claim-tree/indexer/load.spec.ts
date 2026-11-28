import { beforeEach, describe, expect, it } from 'vitest'
import { fetchMyLeaves, loadTree } from '../index.js'
import {
  BACKER_A,
  BACKER_B,
  CAMPAIGN,
  SELECTOR,
  VAULT,
  VAULT_ID,
  blockMock,
  indexerMock,
  payment,
  pledgeCall,
  searchMock,
  setupIndexer,
  spendCall,
} from './test-fixtures.js'

beforeEach(setupIndexer)

describe('fetchMyLeaves', () => {
  it('returns only the viewer’s live leaves', async () => {
    const payA = payment('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', BACKER_A, VAULT, 3_000_000n)
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    const payB = payment('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', BACKER_B, VAULT, 1_000_000n)
    const callB = pledgeCall('NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN', BACKER_B, 100n)
    const cancel = spendCall('PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP', BACKER_A, 101n, SELECTOR.cancel, 0n)
    indexerMock.searchForTransactions.mockImplementation(
      searchMock(
        new Map([
          [CAMPAIGN, [[callA, callB, cancel]]],
          [VAULT_ID, [[]]],
        ]),
      ),
    )
    indexerMock.lookupBlock.mockImplementation(blockMock(new Map([[100n, [payA, callA, payB, callB]]])))

    const leaves = await fetchMyLeaves(CAMPAIGN, BACKER_A)
    expect(leaves).toEqual([])
    const leavesB = await fetchMyLeaves(CAMPAIGN, BACKER_B)
    expect(leavesB.map((leaf) => [leaf.position, leaf.amount])).toEqual([[1, 1_000_000n]])
  })
})

describe('loadTree', () => {
  it('replays pledges in order then nulls spends', async () => {
    const payA = payment('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', BACKER_A, VAULT, 3_000_000n)
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    const payB = payment('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', BACKER_B, VAULT, 1_000_000n)
    const callB = pledgeCall('NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN', BACKER_B, 101n)
    const cancel = spendCall('PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP', BACKER_A, 102n, SELECTOR.cancel, 0n)
    indexerMock.searchForTransactions.mockImplementation(
      searchMock(
        new Map([
          [CAMPAIGN, [[callA], [callB, cancel]]],
          [VAULT_ID, [[]]],
        ]),
      ),
    )
    indexerMock.lookupBlock.mockImplementation(
      blockMock(
        new Map([
          [100n, [payA, callA]],
          [101n, [payB, callB]],
        ]),
      ),
    )

    const tree = await loadTree(CAMPAIGN, VAULT_ID, VAULT)
    expect(tree.leaves.length).toEqual(2)
    expect(tree.raised).toEqual(1_000_000n)
  })

  it('rejects a spend for a position that was never pledged', async () => {
    const ghost = spendCall('GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG', BACKER_A, 100n, SELECTOR.cancel, 5n)
    indexerMock.searchForTransactions.mockImplementation(
      searchMock(
        new Map([
          [CAMPAIGN, [[ghost]]],
          [VAULT_ID, [[]]],
        ]),
      ),
    )

    await expect(loadTree(CAMPAIGN, VAULT_ID, VAULT)).rejects.toThrow(RangeError)
  })
})
