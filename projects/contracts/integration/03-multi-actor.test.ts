import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import type { Account } from 'algosdk'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  ALGO,
  APP_BASE,
  ClaimTreeOracle,
  DEPLOY_FUNDING,
  VAULT_BOX_MBR,
  advanceTime,
  balanceOf,
  campaignBox,
  campaignBoxExists,
  campaignState,
  deployCampaign,
  deployStack,
  isRegistered,
  minBalanceOf,
  pledge,
  spendCampaign,
  type ContractStack,
} from './support/localnet'

interface CampaignFixture {
  appClient: AppClient
  appId: bigint
}

function at<T>(items: T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`missing item at index ${index.toString()}`)
  return item
}

/**
 * 03 - multiple actors and campaigns.
 *
 * Ten campaigns by ten creators, five backers on one campaign, one backer on several, and a creator backing another
 * campaign. The chain then drains one campaign and verifies the other campaigns and the vault pool are untouched.
 */
describe('03 multiple actors and campaigns', () => {
  const fixture = algorandFixture()
  let stack: ContractStack

  beforeAll(async () => {
    stack = await deployStack(fixture)
  })

  describe('ten campaigns by ten creators', { tags: ['happy', 'chain'] }, () => {
    const creators: Account[] = []
    const backers: Account[] = []
    const campaigns: CampaignFixture[] = []
    const oracles: ClaimTreeOracle[] = []
    const campaign0Txids: string[] = []
    let broken = false

    beforeEach((ctx) => {
      ctx.skip(broken, 'a previous multi-actor step failed')
    })

    afterEach((ctx) => {
      ctx.onTestFailed(() => {
        broken = true
      })
    })

    test('CON-050 create 10 campaigns by 10 creators', async () => {
      for (let i = 0; i < 10; i++) {
        const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
        const campaign = await deployCampaign(stack, creator.addr.toString())
        const oracle = new ClaimTreeOracle(`multi-${i.toString()}-`)

        expect((await campaignState(campaign.appClient)).n).toEqual(0n)
        expect((await campaignState(campaign.appClient)).raised).toEqual(0n)
        expect(await isRegistered(stack.factory.client, campaign.appId, stack.ownerAddress)).toEqual(true)

        creators.push(creator)
        campaigns.push(campaign)
        oracles.push(oracle)
      }
      expect(new Set(campaigns.map((campaign) => campaign.appId.toString())).size).toEqual(10)
    })

    test('CON-051 five backers pledge to campaign 0', async () => {
      for (let i = 0; i < 5; i++) {
        const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
        backers.push(backer)
        campaign0Txids.push(
          await pledge(stack, at(campaigns, 0).appClient, at(campaigns, 0).appId, backer.addr.toString(), 1n * ALGO, at(oracles, 0)),
        )
      }

      const state = await campaignState(at(campaigns, 0).appClient)
      expect(state.n).toEqual(5n)
      expect(state.raised).toEqual(5n * ALGO)
    })

    test('CON-052 one backer pledges to several campaigns', async () => {
      await pledge(stack, at(campaigns, 1).appClient, at(campaigns, 1).appId, at(backers, 4).addr.toString(), 2n * ALGO, at(oracles, 1))
      await pledge(stack, at(campaigns, 2).appClient, at(campaigns, 2).appId, at(backers, 4).addr.toString(), 1n * ALGO, at(oracles, 2))

      expect((await campaignState(at(campaigns, 1).appClient)).raised).toEqual(2n * ALGO)
      expect((await campaignState(at(campaigns, 2).appClient)).raised).toEqual(1n * ALGO)
    })

    test('CON-053 a creator backs another campaign', async () => {
      await pledge(stack, at(campaigns, 1).appClient, at(campaigns, 1).appId, at(creators, 0).addr.toString(), 1n * ALGO, at(oracles, 1))

      expect((await campaignState(at(campaigns, 0).appClient)).raised).toEqual(5n * ALGO)
      expect((await campaignState(at(campaigns, 1).appClient)).n).toEqual(2n)
      expect((await campaignState(at(campaigns, 1).appClient)).raised).toEqual(3n * ALGO)
    })

    test('CON-054 drain campaign 0 without touching the others', async () => {
      await advanceTime(fixture, 900)
      for (let i = 0; i < backers.length; i++) {
        await spendCampaign(
          stack,
          at(campaigns, 0).appClient,
          at(campaigns, 0).appId,
          at(backers, i).addr.toString(),
          i,
          1n * ALGO,
          at(campaign0Txids, i),
          'refund(uint64,uint64,byte[],byte[])void',
          at(oracles, 0),
        )
      }

      const drained = await campaignState(at(campaigns, 0).appClient)
      expect(drained.n).toEqual(5n)
      expect(drained.raised).toEqual(0n)
      expect((await campaignState(at(campaigns, 1).appClient)).raised).toEqual(3n * ALGO)
      expect((await campaignState(at(campaigns, 2).appClient)).raised).toEqual(1n * ALGO)

      const box0 = await campaignBox(stack.vault.client, at(campaigns, 0).appId)
      const box1 = await campaignBox(stack.vault.client, at(campaigns, 1).appId)
      const box2 = await campaignBox(stack.vault.client, at(campaigns, 2).appId)
      expect(box0.paidIn).toEqual(5n * ALGO)
      expect(box0.paidOut).toEqual(5n * ALGO)
      expect(box1.paidIn).toEqual(3n * ALGO)
      expect(box1.paidOut).toEqual(0n)
      expect(box2.paidIn).toEqual(1n * ALGO)
      expect(box2.paidOut).toEqual(0n)
    })

    test('CON-055 vault pool holds only the live pledges', async () => {
      expect(await balanceOf(stack.algorand, stack.vault.address)).toEqual(DEPLOY_FUNDING + 4n * ALGO)
      expect(await minBalanceOf(stack.algorand, stack.vault.address)).toEqual(APP_BASE + 3n * VAULT_BOX_MBR)
    })
  })

  test('CON-060 creators can back each other', { tags: ['happy', 'always'] }, async () => {
    const creatorA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const creatorB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const campaignA = await deployCampaign(stack, creatorA.addr.toString())
    const campaignB = await deployCampaign(stack, creatorB.addr.toString())
    const oracleA = new ClaimTreeOracle('cross-a-')
    const oracleB = new ClaimTreeOracle('cross-b-')

    await pledge(stack, campaignA.appClient, campaignA.appId, creatorB.addr.toString(), 1n * ALGO, oracleA)
    await pledge(stack, campaignB.appClient, campaignB.appId, creatorA.addr.toString(), 1n * ALGO, oracleB)

    expect((await campaignState(campaignA.appClient)).n).toEqual(1n)
    expect((await campaignState(campaignA.appClient)).raised).toEqual(1n * ALGO)
    expect((await campaignState(campaignB.appClient)).n).toEqual(1n)
    expect((await campaignState(campaignB.appClient)).raised).toEqual(1n * ALGO)
  })

  test('CON-061 refunding one campaign leaves the other untouched', { tags: ['happy', 'always'] }, async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const campaignA = await deployCampaign(stack, creator.addr.toString())
    const campaignB = await deployCampaign(stack, creator.addr.toString())
    const oracleA = new ClaimTreeOracle('isolated-a-')
    const oracleB = new ClaimTreeOracle('isolated-b-')

    const txid = await pledge(stack, campaignA.appClient, campaignA.appId, backer.addr.toString(), 2n * ALGO, oracleA)
    await advanceTime(fixture, 900)
    await spendCampaign(
      stack,
      campaignA.appClient,
      campaignA.appId,
      backer.addr.toString(),
      0,
      2n * ALGO,
      txid,
      'refund(uint64,uint64,byte[],byte[])void',
      oracleA,
    )

    expect((await campaignState(campaignA.appClient)).raised).toEqual(0n)
    expect((await campaignState(campaignB.appClient)).n).toEqual(0n)
    expect((await campaignState(campaignB.appClient)).raised).toEqual(0n)
    expect(await campaignBoxExists(stack.vault.client, campaignA.appId)).toEqual(true)
    expect(await campaignBoxExists(stack.vault.client, campaignB.appId)).toEqual(false)
    expect(oracleB.state().n).toEqual(0)
  })
})
