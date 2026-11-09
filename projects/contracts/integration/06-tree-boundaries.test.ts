import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import type { Account } from 'algosdk'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  ALGO,
  ClaimTreeOracle,
  FEE,
  VAULT_BOX_MBR,
  advanceTime,
  balanceOf,
  campaignBoxExists,
  campaignState,
  deleteCampaign,
  deployCampaign,
  deployStack,
  minBalanceOf,
  pledge,
  spendCampaign,
  spendVault,
  type ContractStack,
} from './support/localnet'

interface CampaignFixture {
  appClient: AppClient
  appId: bigint
  oracle: ClaimTreeOracle
}

function at<T>(items: T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`missing item at index ${index.toString()}`)
  return item
}

async function createCampaign(fixture: AlgorandFixture, stack: ContractStack, options: { goal?: bigint } = {}): Promise<CampaignFixture> {
  const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
  const campaign = await deployCampaign(stack, creator.addr.toString(), options)
  return { ...campaign, oracle: new ClaimTreeOracle('scale-') }
}

describe('06 tree boundaries', () => {
  const fixture = algorandFixture()
  let stack: ContractStack

  beforeAll(async () => {
    stack = await deployStack(fixture)
  })

  test('CON-200 N=16 crosses the first OpUp take and refunds leaf 0', { tags: ['scale', 'happy', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack, { goal: 1_000n * ALGO })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })

    const txids: string[] = []
    for (let i = 0; i < 16; i++) {
      txids.push(await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * ALGO, campaign.oracle))
    }

    const state = await campaignState(campaign.appClient)
    expect(state.n).toEqual(16n)
    expect(state.raised).toEqual(16n * ALGO)

    await advanceTime(fixture, 900)
    await spendCampaign(
      stack,
      campaign.appClient,
      campaign.appId,
      backer.addr.toString(),
      0,
      1n * ALGO,
      at(txids, 0),
      'refund(uint64,uint64,byte[],byte[])void',
      campaign.oracle,
    )
    expect((await campaignState(campaign.appClient)).raised).toEqual(15n * ALGO)
  })

  test('CON-201 N=100 refunds the worst-case and an interior leaf', { tags: ['scale', 'happy', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack, { goal: 1_000n * ALGO })
    const backer = await fixture.context.generateAccount({ initialFunds: (200).algo(), suppressLog: true })

    const txids: string[] = []
    for (let i = 0; i < 100; i++) {
      txids.push(await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * ALGO, campaign.oracle))
    }

    const state = await campaignState(campaign.appClient)
    expect(state.n).toEqual(100n)
    expect(state.raised).toEqual(100n * ALGO)

    await advanceTime(fixture, 900)
    await spendCampaign(
      stack,
      campaign.appClient,
      campaign.appId,
      backer.addr.toString(),
      0,
      1n * ALGO,
      at(txids, 0),
      'refund(uint64,uint64,byte[],byte[])void',
      campaign.oracle,
    )
    await spendCampaign(
      stack,
      campaign.appClient,
      campaign.appId,
      backer.addr.toString(),
      50,
      1n * ALGO,
      at(txids, 50),
      'refund(uint64,uint64,byte[],byte[])void',
      campaign.oracle,
    )
    expect((await campaignState(campaign.appClient)).raised).toEqual(98n * ALGO)
  })

  const LADDER = [
    { id: 'CON-210', n: 15 },
    { id: 'CON-211', n: 16 },
    { id: 'CON-212', n: 31 },
    { id: 'CON-213', n: 32 },
    { id: 'CON-214', n: 63 },
    { id: 'CON-215', n: 64 },
    { id: 'CON-216', n: 100 },
    { id: 'CON-217', n: 127 },
    { id: 'CON-218', n: 128 },
    { id: 'CON-219', n: 255 },
    { id: 'CON-220', n: 1_000 },
    { id: 'CON-221', n: 1_024 },
  ] as const

  // One campaign grows through the ladder; only CON-210 creates it, so run this block in order.
  describe('cumulative boundary ladder', { tags: ['scale', 'happy', 'chain'] }, () => {
    let broken = false
    let creator: Account
    let campaign: CampaignFixture
    let backers: Account[] = []
    const txids: string[] = []
    let currentN = 0
    let refunded = 0
    let nextLeaf = 0

    beforeEach((ctx) => {
      ctx.skip(broken, 'a previous boundary step failed')
    })

    afterEach((ctx) => {
      ctx.onTestFailed(() => {
        broken = true
      })
    })

    async function pledgeTo(target: number): Promise<void> {
      for (let i = currentN; i < target; i++) {
        const backer = at(backers, i % backers.length)
        txids.push(await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * ALGO, campaign.oracle))
      }
      currentN = target
    }

    async function cancelNext(boost = false): Promise<void> {
      const index = nextLeaf
      nextLeaf += 1
      await spendCampaign(
        stack,
        campaign.appClient,
        campaign.appId,
        at(backers, index % backers.length).addr.toString(),
        index,
        1n * ALGO,
        at(txids, index),
        'cancelPledge(uint64,uint64,byte[],byte[])void',
        campaign.oracle,
        { budgetBooster: boost },
      )
      refunded += 1
    }

    for (const boundary of LADDER) {
      test(`${boundary.id} N=${boundary.n.toString()}`, async () => {
        if (boundary.n === 15) {
          creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
          const deployed = await deployCampaign(stack, creator.addr.toString(), { goal: 2_000n * ALGO })
          campaign = { ...deployed, oracle: new ClaimTreeOracle('ladder-') }
          backers = []
          for (let i = 0; i < 5; i++) {
            backers.push(await fixture.context.generateAccount({ initialFunds: (300).algo(), suppressLog: true }))
          }
        }

        await pledgeTo(boundary.n)
        const before = await campaignState(campaign.appClient)
        expect(before.n).toEqual(BigInt(boundary.n))
        expect(before.raised).toEqual(BigInt(boundary.n - refunded) * ALGO)

        await cancelNext(boundary.n >= 1_000)
        expect((await campaignState(campaign.appClient)).raised).toEqual(BigInt(boundary.n - refunded) * ALGO)

        if (boundary.n === 1_024) {
          await advanceTime(fixture, 900)

          const refundIndex = nextLeaf
          nextLeaf += 1
          refunded += 1
          await spendCampaign(
            stack,
            campaign.appClient,
            campaign.appId,
            at(backers, refundIndex % backers.length).addr.toString(),
            refundIndex,
            1n * ALGO,
            at(txids, refundIndex),
            'refund(uint64,uint64,byte[],byte[])void',
            campaign.oracle,
            { budgetBooster: true },
          )

          await deleteCampaign(stack, campaign.appId, creator.addr.toString())

          const vaultIndex = nextLeaf
          nextLeaf += 1
          refunded += 1
          await spendVault(
            stack,
            campaign.appId,
            at(backers, vaultIndex % backers.length).addr.toString(),
            vaultIndex,
            1n * ALGO,
            at(txids, vaultIndex),
            campaign.oracle,
            { budgetBooster: true },
          )

          const sweeperBefore = await balanceOf(stack.algorand, stack.sweeperAddress)
          const vaultMinBefore = await minBalanceOf(stack.algorand, stack.vault.address)
          await advanceTime(fixture, 4_000)
          await stack.vault.client.send.call({
            method: 'finalize(uint64)void',
            args: [campaign.appId],
            sender: at(backers, 0).addr,
            extraFee: microAlgos(FEE),
            suppressLog: true,
          })

          expect(await balanceOf(stack.algorand, stack.sweeperAddress)).toEqual(sweeperBefore + BigInt(1_024 - refunded) * ALGO)
          expect(await minBalanceOf(stack.algorand, stack.vault.address)).toEqual(vaultMinBefore - VAULT_BOX_MBR)
          expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
        }
      })
    }
  })
})
