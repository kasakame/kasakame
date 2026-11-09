import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
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

describe('05 many actors and campaigns', () => {
  const fixture = algorandFixture()
  let stack: ContractStack

  beforeAll(async () => {
    stack = await deployStack(fixture)
  })

  test('CON-202 25 campaigns by 25 creators with 4 backers each', { tags: ['scale', 'happy', 'always'] }, async () => {
    const campaigns: CampaignFixture[] = []
    const creators: Account[] = []
    const backers: Account[][] = []
    const txids: string[][] = []

    for (let i = 0; i < 25; i++) {
      const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      const campaign = await createCampaign(fixture, stack)
      const campaignBackers: Account[] = []
      const campaignTxids: string[] = []

      for (let j = 0; j < 4; j++) {
        const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
        campaignBackers.push(backer)
        campaignTxids.push(await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * ALGO, campaign.oracle))
      }

      const state = await campaignState(campaign.appClient)
      expect(state.n).toEqual(4n)
      expect(state.raised).toEqual(4n * ALGO)

      creators.push(creator)
      campaigns.push(campaign)
      backers.push(campaignBackers)
      txids.push(campaignTxids)
    }

    expect(new Set(campaigns.map((campaign) => campaign.appId.toString())).size).toEqual(25)

    await advanceTime(fixture, 900)
    for (let i = 0; i < 4; i++) {
      await spendCampaign(
        stack,
        at(campaigns, 0).appClient,
        at(campaigns, 0).appId,
        at(at(backers, 0), i).addr.toString(),
        i,
        1n * ALGO,
        at(at(txids, 0), i),
        'refund(uint64,uint64,byte[],byte[])void',
        at(campaigns, 0).oracle,
      )
    }

    expect((await campaignState(at(campaigns, 0).appClient)).raised).toEqual(0n)
    expect((await campaignState(at(campaigns, 1).appClient)).raised).toEqual(4n * ALGO)
    const box0 = await campaignBox(stack.vault.client, at(campaigns, 0).appId)
    const box1 = await campaignBox(stack.vault.client, at(campaigns, 1).appId)
    expect(box0.paidOut).toEqual(4n * ALGO)
    expect(box1.paidOut).toEqual(0n)
    expect(creators.length).toEqual(25)
  })
})
