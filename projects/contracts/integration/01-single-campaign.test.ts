import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import type { Account } from 'algosdk'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  ALGO,
  ClaimTreeOracle,
  campaignBoxExists,
  campaignState,
  deleteCampaign,
  deployCampaign,
  deployStack,
  isRegistered,
  pledge,
  spendCampaign,
  type ContractStack,
} from './support/localnet'

interface CampaignFixture {
  appClient: AppClient
  appId: bigint
}

/**
 * 01 - one campaign, simple happy path.
 *
 * The chain creates one campaign and reuses it for pledge -> cancel -> delete. The standalone tests create their own
 * campaign so they can run alone with `vitest -t <ID>`.
 */
describe('01 single campaign', () => {
  const fixture = algorandFixture()
  let stack: ContractStack

  beforeAll(async () => {
    stack = await deployStack(fixture)
  })

  describe('campaign A lifecycle', { tags: ['smoke', 'happy', 'chain'] }, () => {
    let broken = false
    let creator: Account
    let backer: Account
    let campaign: CampaignFixture
    let oracle: ClaimTreeOracle
    let txid: string

    beforeEach((ctx) => {
      ctx.skip(broken, 'a previous single-campaign step failed')
    })

    afterEach((ctx) => {
      ctx.onTestFailed(() => {
        broken = true
      })
    })

    test('CON-010 create campaign A', async () => {
      creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      campaign = await deployCampaign(stack, creator.addr.toString())
      oracle = new ClaimTreeOracle('single-campaign-')

      expect((await campaignState(campaign.appClient)).n).toEqual(0n)
      expect((await campaignState(campaign.appClient)).raised).toEqual(0n)
      expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
      expect(await isRegistered(stack.factory.client, campaign.appId, stack.ownerAddress)).toEqual(true)
    })

    test('CON-011 pledge to campaign A', async () => {
      backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      txid = await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 2n * ALGO, oracle)

      const state = await campaignState(campaign.appClient)
      expect(state.n).toEqual(1n)
      expect(state.raised).toEqual(2n * ALGO)
      expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(true)
    })

    test('CON-012 cancel the pledge', async () => {
      await spendCampaign(
        stack,
        campaign.appClient,
        campaign.appId,
        backer.addr.toString(),
        0,
        2n * ALGO,
        txid,
        'cancelPledge(uint64,uint64,byte[],byte[])void',
        oracle,
      )

      expect((await campaignState(campaign.appClient)).raised).toEqual(0n)
    })

    test('CON-013 delete the cancelled campaign', async () => {
      await deleteCampaign(stack, campaign.appId, creator.addr.toString())

      await expect(stack.algorand.app.getById(campaign.appId)).rejects.toThrow()
      expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(true)
    })
  })

  test('CON-014 delete a pristine campaign', { tags: ['smoke', 'happy', 'always'] }, async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const campaign = await deployCampaign(stack, creator.addr.toString())

    await deleteCampaign(stack, campaign.appId, creator.addr.toString())

    await expect(stack.algorand.app.getById(campaign.appId)).rejects.toThrow()
    expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
  })

  test('CON-015 single-test happy path: create, pledge, cancel, delete', { tags: ['smoke', 'happy', 'always'] }, async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const campaign = await deployCampaign(stack, creator.addr.toString())
    const oracle = new ClaimTreeOracle('single-test-')

    const txid = await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 2n * ALGO, oracle)
    await spendCampaign(
      stack,
      campaign.appClient,
      campaign.appId,
      backer.addr.toString(),
      0,
      2n * ALGO,
      txid,
      'cancelPledge(uint64,uint64,byte[],byte[])void',
      oracle,
    )
    await deleteCampaign(stack, campaign.appId, creator.addr.toString())

    await expect(stack.algorand.app.getById(campaign.appId)).rejects.toThrow()
  })
})
