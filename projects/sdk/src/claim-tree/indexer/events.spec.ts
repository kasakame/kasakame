import { hexToBytes } from 'algosdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { fetchPledges, fetchSpends } from '../index.js'
import {
  BACKER_A,
  BACKER_B,
  CAMPAIGN,
  SELECTOR,
  VAULT,
  VAULT_ID,
  appCall,
  blockMock,
  indexerMock,
  payment,
  pledgeCall,
  searchMock,
  setupIndexer,
  spendCall,
  vaultRefundCall,
} from './test-fixtures.js'

beforeEach(setupIndexer)

describe('fetchPledges', () => {
  it('pairs each pledge with its group payment across rounds, in chain order', async () => {
    // Block 100 exercises every scan-skip branch before the match: wrong sender, app call, wrong receiver, zero amount, and a full match without id.
    const decoySender = payment('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', BACKER_B, VAULT, 9n)
    const decoyApp = appCall('TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT', BACKER_A, 100n, [hexToBytes(SELECTOR.claim)])
    const decoyReceiver = {
      id: 'UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU',
      sender: BACKER_A,
      paymentTransaction: { amount: 9n, receiver: BACKER_B },
    }
    const decoyZero = {
      id: 'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
      sender: BACKER_A,
      paymentTransaction: { amount: 0n, receiver: VAULT },
    }
    const decoyNoId = { sender: BACKER_A, paymentTransaction: { amount: 9n, receiver: VAULT } }
    const payA = payment('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', BACKER_A, VAULT, 3_000_000n)
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    const payB = payment('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', BACKER_B, VAULT, 1_000_000n)
    const callB = pledgeCall('NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN', BACKER_B, 100n)
    const payC = payment('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', BACKER_A, VAULT, 2_000_000n)
    const callC = pledgeCall('OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO', BACKER_A, 101n)
    const payD = payment('DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', BACKER_B, VAULT, 4_000_000n)
    const callD = pledgeCall('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', BACKER_B, 102n)
    const noRoundCall = {
      sender: BACKER_A,
      applicationTransaction: { applicationArgs: [hexToBytes(SELECTOR.pledge)] },
    }
    const noArgsCall = {
      id: 'HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH',
      sender: BACKER_A,
      confirmedRound: 100n,
    }
    indexerMock.searchForTransactions.mockImplementation(
      searchMock(
        new Map([
          [
            CAMPAIGN,
            [
              [callC, callD],
              [callA, callB, noRoundCall, noArgsCall],
            ],
          ],
        ]),
      ),
    )
    indexerMock.lookupBlock.mockImplementation(
      blockMock(
        new Map([
          // Scan skips backwards from callA: id-less match, zero amount, wrong receiver, app call, wrong sender - the interleaving only exercises the skip branches.
          [100n, [payA, decoySender, decoyApp, decoyReceiver, decoyZero, decoyNoId, callA, payB, callB]],
          [101n, [payC, callC]],
          [102n, [payD, callD]],
        ]),
      ),
    )

    const pledges = await fetchPledges(CAMPAIGN, VAULT)
    expect(pledges.map((p) => [p.backer, p.amount, p.txidHex, p.round])).toEqual([
      [BACKER_A, 3_000_000n, expect.any(String), 100n],
      [BACKER_B, 1_000_000n, expect.any(String), 100n],
      [BACKER_A, 2_000_000n, expect.any(String), 101n],
      [BACKER_B, 4_000_000n, expect.any(String), 102n],
    ])
    // TxIDs come from the paired payments (base32 → hex), not from the app calls.
    expect(pledges[0]?.txidHex).not.toEqual(pledges[2]?.txidHex)
  })

  it('bounds concurrent block lookups', async () => {
    const calls: unknown[] = []
    const blocks = new Map<bigint, unknown[]>()
    for (let index = 0; index < 40; index++) {
      const round = 100n + BigInt(index)
      const pay = payment('A'.repeat(52), BACKER_A, VAULT, 1_000_000n)
      const call = pledgeCall('B'.repeat(52), BACKER_A, round)
      calls.push(call)
      blocks.set(round, [pay, call])
    }
    indexerMock.searchForTransactions.mockImplementation(searchMock(new Map([[CAMPAIGN, [calls]]])))
    let active = 0
    let peak = 0
    indexerMock.lookupBlock.mockImplementation((round: number | bigint) => ({
      do: async () => {
        active += 1
        peak = Math.max(peak, active)
        await Promise.resolve()
        active -= 1
        return { transactions: blocks.get(BigInt(round)) ?? [] }
      },
    }))

    const pledges = await fetchPledges(CAMPAIGN, VAULT)

    expect(pledges).toHaveLength(40)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(16)
  })

  it('ignores non-pledge calls', async () => {
    const claim = appCall('ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ', BACKER_A, 100n, [hexToBytes(SELECTOR.claim)])
    indexerMock.searchForTransactions.mockImplementation(searchMock(new Map([[CAMPAIGN, [[claim]]]])))
    indexerMock.lookupBlock.mockImplementation(blockMock(new Map([[100n, [claim]]])))

    expect(await fetchPledges(CAMPAIGN, VAULT)).toEqual([])
  })

  it('throws when a pledge has no pairable payment', async () => {
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    indexerMock.searchForTransactions.mockImplementation(searchMock(new Map([[CAMPAIGN, [[callA]]]])))
    indexerMock.lookupBlock.mockImplementation(
      blockMock(new Map([[100n, [{ sender: BACKER_B, paymentTransaction: { amount: 9n, receiver: VAULT } }, callA]]])),
    )

    await expect(fetchPledges(CAMPAIGN, VAULT)).rejects.toThrow(/no paired payment/)
  })

  it('throws for id-less calls missing from their round block', async () => {
    const noId = (sender: string) => ({
      sender,
      confirmedRound: 100n,
      applicationTransaction: { applicationArgs: [hexToBytes(SELECTOR.pledge)] },
    })
    indexerMock.searchForTransactions.mockImplementation(searchMock(new Map([[CAMPAIGN, [[noId(BACKER_A), noId(BACKER_B)]]]])))
    indexerMock.lookupBlock.mockImplementation(blockMock(new Map([[100n, []]])))

    await expect(fetchPledges(CAMPAIGN, VAULT)).rejects.toThrow(/not found in its round block/)
  })

  it('sorts later rounds arriving first back into chain order', async () => {
    const payB = payment('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', BACKER_B, VAULT, 1_000_000n)
    const callB = pledgeCall('NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN', BACKER_B, 102n)
    const payA = payment('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', BACKER_A, VAULT, 3_000_000n)
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    indexerMock.searchForTransactions.mockImplementation(searchMock(new Map([[CAMPAIGN, [[callB], [callA]]]])))
    indexerMock.lookupBlock.mockImplementation(
      blockMock(
        new Map([
          [102n, [payB, callB]],
          [100n, [payA, callA]],
        ]),
      ),
    )

    const pledges = await fetchPledges(CAMPAIGN, VAULT)
    expect(pledges.map((p) => [p.backer, p.round])).toEqual([
      [BACKER_A, 100n],
      [BACKER_B, 102n],
    ])
  })

  it('keeps chain order when block indexes decrease across rounds', async () => {
    const payA = payment('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', BACKER_A, VAULT, 3_000_000n)
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    const fillers = Array.from({ length: 9 }, (_, index) =>
      appCall(`FILLER${index.toString()}`, BACKER_B, 100n, [hexToBytes(SELECTOR.claim)]),
    )
    const payB = payment('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', BACKER_B, VAULT, 1_000_000n)
    const callB = pledgeCall('NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN', BACKER_B, 101n)
    indexerMock.searchForTransactions.mockImplementation(searchMock(new Map([[CAMPAIGN, [[callB], [callA]]]])))
    indexerMock.lookupBlock.mockImplementation(
      blockMock(
        new Map([
          [100n, [payA, ...fillers, callA]],
          [101n, [payB, callB]],
        ]),
      ),
    )

    const pledges = await fetchPledges(CAMPAIGN, VAULT)
    expect(pledges.map((p) => [p.backer, p.round])).toEqual([
      [BACKER_A, 100n],
      [BACKER_B, 101n],
    ])
  })

  it('throws when a call has no id to locate with', async () => {
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    const payA = payment('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', BACKER_A, VAULT, 3_000_000n)
    const noIdCall = {
      sender: BACKER_A,
      confirmedRound: 100n,
      applicationTransaction: { applicationArgs: [hexToBytes(SELECTOR.pledge)] },
    }
    indexerMock.searchForTransactions.mockImplementation(searchMock(new Map([[CAMPAIGN, [[callA, noIdCall]]]])))
    indexerMock.lookupBlock.mockImplementation(blockMock(new Map([[100n, [payA, callA]]])))

    await expect(fetchPledges(CAMPAIGN, VAULT)).rejects.toThrow(/not found in its round block/)
  })

  it('throws when a pledge call is missing from its round block', async () => {
    const callA = pledgeCall('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', BACKER_A, 100n)
    indexerMock.searchForTransactions.mockImplementation(searchMock(new Map([[CAMPAIGN, [[callA]]]])))
    // Block response without a transactions key (torn read): treated as empty, so the call is missing.
    indexerMock.lookupBlock.mockImplementation(() => ({
      do: () => Promise.resolve({}),
    }))

    await expect(fetchPledges(CAMPAIGN, VAULT)).rejects.toThrow(/not found in its round block/)
  })
})

describe('fetchSpends', () => {
  it('collects campaign and vault spends for this campaign only', async () => {
    const cancel = spendCall('PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP', BACKER_A, 100n, SELECTOR.cancel, 2n)
    const refund = spendCall('QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ', BACKER_B, 101n, SELECTOR.refund, 0n)
    const shortCancel = appCall('IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII', BACKER_A, 100n, [hexToBytes(SELECTOR.cancel)])
    const vaultOurs = vaultRefundCall('RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR', BACKER_A, 102n, CAMPAIGN, 1n)
    const vaultTheirs = vaultRefundCall('SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS', BACKER_A, 102n, 999n, 5n)
    const vaultShort = appCall('JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ', BACKER_A, 102n, [hexToBytes(SELECTOR.vaultRefund)])
    const credit = appCall('TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT', BACKER_A, 100n, [hexToBytes(SELECTOR.credit)])
    indexerMock.searchForTransactions.mockImplementation(
      searchMock(
        new Map([
          [CAMPAIGN, [[cancel, refund, shortCancel]]],
          [VAULT_ID, [[vaultOurs, vaultTheirs, vaultShort, credit]]],
        ]),
      ),
    )

    expect(await fetchSpends(CAMPAIGN, VAULT_ID)).toEqual([{ position: 2 }, { position: 0 }, { position: 1 }])
  })
})
