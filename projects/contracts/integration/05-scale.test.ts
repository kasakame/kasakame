import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import type { Account } from 'algosdk'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  ALGO,
  ClaimTreeOracle,
  advanceTime,
  campaignBox,
  campaignState,
  deployCampaign,
  deployStack,
  pledge,
  spendCampaign,
  type ContractStack,
} from './support/localnet'
import { backersPerCampaign, describeScale, scaleConfig } from './support/scale'

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

const scale = scaleConfig('heavy')

describe('05 many actors and campaigns', () => {
  const fixture = algorandFixture()
  let stack: ContractStack

  beforeAll(async () => {
    stack = await deployStack(fixture)
  })

  test(
    `CON-202 ${scale.campaigns.toString()} campaigns by ${scale.creators.toString()} creators with ${backersPerCampaign(scale).toString()} backers each`,
    { tags: ['scale', 'happy', 'always'] },
    async () => {
      console.log(describeScale(scale))
      expect(scale.campaigns).toBeGreaterThanOrEqual(2)

      const perCampaign = backersPerCampaign(scale)
      const total = perCampaign * scale.pledgesPerBacker
      const goal = BigInt(total + 1) * ALGO

      const creators: Account[] = []
      for (let i = 0; i < scale.creators; i++) {
        creators.push(await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true }))
      }

      const campaigns: CampaignFixture[] = []
      const backers: Account[][] = []
      const txids: string[][] = []

      for (let i = 0; i < scale.campaigns; i++) {
        const creator = at(creators, i % creators.length)
        const deployed = await deployCampaign(stack, creator.addr.toString(), { goal })
        const campaign = { ...deployed, oracle: new ClaimTreeOracle('scale-') }
        const campaignBackers: Account[] = []
        const campaignTxids: string[] = []

        for (let j = 0; j < perCampaign; j++) {
          const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
          campaignBackers.push(backer)
          for (let p = 0; p < scale.pledgesPerBacker; p++) {
            campaignTxids.push(await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * ALGO, campaign.oracle))
          }
        }

        const state = await campaignState(campaign.appClient)
        expect(state.n).toEqual(BigInt(total))
        expect(state.raised).toEqual(BigInt(total) * ALGO)

        campaigns.push(campaign)
        backers.push(campaignBackers)
        txids.push(campaignTxids)
      }

      expect(new Set(campaigns.map((campaign) => campaign.appId.toString())).size).toEqual(scale.campaigns)
      expect(new Set(backers.flat().map((backer) => backer.addr.toString())).size).toEqual(scale.backers)
      expect(creators.length).toEqual(scale.creators)

      await advanceTime(fixture, 900)
      for (let leaf = 0; leaf < total; leaf++) {
        const backer = at(at(backers, 0), Math.floor(leaf / scale.pledgesPerBacker))
        await spendCampaign(
          stack,
          at(campaigns, 0).appClient,
          at(campaigns, 0).appId,
          backer.addr.toString(),
          leaf,
          1n * ALGO,
          at(at(txids, 0), leaf),
          'refund(uint64,uint64,byte[],byte[])void',
          at(campaigns, 0).oracle,
        )
      }

      expect((await campaignState(at(campaigns, 0).appClient)).raised).toEqual(0n)
      expect((await campaignState(at(campaigns, 1).appClient)).raised).toEqual(BigInt(total) * ALGO)
      const box0 = await campaignBox(stack.vault.client, at(campaigns, 0).appId)
      const box1 = await campaignBox(stack.vault.client, at(campaigns, 1).appId)
      expect(box0.paidOut).toEqual(BigInt(total) * ALGO)
      expect(box1.paidOut).toEqual(0n)
    },
  )
})
