import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  ALGO,
  ClaimTreeOracle,
  advanceTime,
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
})
