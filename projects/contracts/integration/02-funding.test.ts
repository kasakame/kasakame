import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import type { Account } from 'algosdk'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  ALGO,
  ClaimTreeOracle,
  FEE,
  FEE_CLAIM,
  VAULT_BOX_MBR,
  advanceTime,
  balanceOf,
  campaignBox,
  campaignBoxExists,
  campaignState,
  claimCampaign,
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
}

/**
 * 02 - funding outcomes.
 *
 * Failed campaign: refund before and after delete, reject early finalize, sweep the residual after the window.
 * Successful campaign: claim and delete. The standalone tests repeat each workflow so they can run alone.
 */
describe('02 funding outcomes', () => {
  const fixture = algorandFixture()
  let stack: ContractStack

  beforeAll(async () => {
    stack = await deployStack(fixture)
  })

  describe('failed campaign lifecycle', { tags: ['happy', 'chain'] }, () => {
    let broken = false
    let creator: Account
    let backerA: Account
    let backerB: Account
    let backerC: Account
    let campaign: CampaignFixture
    let oracle: ClaimTreeOracle
    let txA: string
    let txB: string

    beforeEach((ctx) => {
      ctx.skip(broken, 'a previous failed-campaign step failed')
    })

    afterEach((ctx) => {
      ctx.onTestFailed(() => {
        broken = true
      })
    })

    test('CON-020 create campaign F', async () => {
      creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      campaign = await deployCampaign(stack, creator.addr.toString())
      oracle = new ClaimTreeOracle('failed-campaign-')
      expect((await campaignState(campaign.appClient)).n).toEqual(0n)
    })

    test('CON-021 three backers pledge below the goal', async () => {
      backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      backerC = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })

      txA = await pledge(stack, campaign.appClient, campaign.appId, backerA.addr.toString(), 3n * ALGO, oracle)
      txB = await pledge(stack, campaign.appClient, campaign.appId, backerB.addr.toString(), 1n * ALGO, oracle)
      await pledge(stack, campaign.appClient, campaign.appId, backerC.addr.toString(), 2n * ALGO, oracle)

      const state = await campaignState(campaign.appClient)
      expect(state.n).toEqual(3n)
      expect(state.raised).toEqual(6n * ALGO)
    })

    test('CON-022 advance and refund one backer through the campaign', async () => {
      await advanceTime(fixture, 900)
      await spendCampaign(
        stack,
        campaign.appClient,
        campaign.appId,
        backerA.addr.toString(),
        0,
        3n * ALGO,
        txA,
        'refund(uint64,uint64,byte[],byte[])void',
        oracle,
      )
      expect((await campaignState(campaign.appClient)).raised).toEqual(3n * ALGO)
    })

    test('CON-023 delete the failed campaign', async () => {
      await deleteCampaign(stack, campaign.appId, creator.addr.toString())
      const box = await campaignBox(stack.vault.client, campaign.appId)
      expect(box.status).toEqual(2)
      expect(box.n).toEqual(3n)
      await expect(stack.algorand.app.getById(campaign.appId)).rejects.toThrow()
    })

    test('CON-024 refund another backer through the vault after delete', async () => {
      await spendVault(stack, campaign.appId, backerB.addr.toString(), 1, 1n * ALGO, txB, oracle)
      const box = await campaignBox(stack.vault.client, campaign.appId)
      expect(box.paidOut).toEqual(4n * ALGO)
    })

    test('CON-025 reject early finalize, then sweep the residual', async () => {
      await expect(
        stack.vault.client.send.call({
          method: 'finalize(uint64)void',
          args: [campaign.appId],
          sender: backerA.addr,
          extraFee: microAlgos(FEE),
          suppressLog: true,
        }),
      ).rejects.toThrow(/refund window still open/)

      const sweeperBefore = await balanceOf(stack.algorand, stack.sweeperAddress)
      const vaultMinBefore = await minBalanceOf(stack.algorand, stack.vault.address)
      await advanceTime(fixture, 4_000)
      await stack.vault.client.send.call({
        method: 'finalize(uint64)void',
        args: [campaign.appId],
        sender: backerA.addr,
        extraFee: microAlgos(FEE),
        suppressLog: true,
      })

      expect(await balanceOf(stack.algorand, stack.sweeperAddress)).toEqual(sweeperBefore + 2n * ALGO)
      expect(await minBalanceOf(stack.algorand, stack.vault.address)).toEqual(vaultMinBefore - VAULT_BOX_MBR)
      expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
    })
  })

  describe('successful campaign lifecycle', { tags: ['happy', 'chain'] }, () => {
    let broken = false
    let creator: Account
    let backerA: Account
    let backerB: Account
    let campaign: CampaignFixture
    let oracle: ClaimTreeOracle

    beforeEach((ctx) => {
      ctx.skip(broken, 'a previous successful-campaign step failed')
    })

    afterEach((ctx) => {
      ctx.onTestFailed(() => {
        broken = true
      })
    })

    test('CON-030 create campaign S with a 3 ALGO goal', async () => {
      creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      campaign = await deployCampaign(stack, creator.addr.toString(), { goal: 3n * ALGO })
      oracle = new ClaimTreeOracle('successful-campaign-')
      expect((await campaignState(campaign.appClient)).n).toEqual(0n)
    })

    test('CON-031 fund the campaign to its goal', async () => {
      backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      await pledge(stack, campaign.appClient, campaign.appId, backerA.addr.toString(), 2n * ALGO, oracle)
      await pledge(stack, campaign.appClient, campaign.appId, backerB.addr.toString(), 1n * ALGO, oracle)

      const state = await campaignState(campaign.appClient)
      expect(state.n).toEqual(2n)
      expect(state.raised).toEqual(3n * ALGO)
    })

    test('CON-032 advance and claim', async () => {
      const creatorBefore = await balanceOf(stack.algorand, creator.addr.toString())
      await advanceTime(fixture, 900)
      await claimCampaign(stack, campaign.appClient, campaign.appId, creator.addr.toString())

      expect(await balanceOf(stack.algorand, creator.addr.toString())).toEqual(creatorBefore + 3n * ALGO - FEE_CLAIM)
      const box = await campaignBox(stack.vault.client, campaign.appId)
      expect(box.status).toEqual(3)
      expect(box.paidOut).toEqual(box.paidIn)
    })

    test('CON-033 delete the claimed campaign and release its box', async () => {
      await deleteCampaign(stack, campaign.appId, creator.addr.toString(), { vaultBoxRelease: true })
      await expect(stack.algorand.app.getById(campaign.appId)).rejects.toThrow()
      expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
    })
  })

  test('CON-040 standalone failed campaign workflow', { tags: ['happy', 'always'] }, async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const campaign = await deployCampaign(stack, creator.addr.toString())
    const oracle = new ClaimTreeOracle('standalone-failed-')

    const txA = await pledge(stack, campaign.appClient, campaign.appId, backerA.addr.toString(), 2n * ALGO, oracle)
    const txB = await pledge(stack, campaign.appClient, campaign.appId, backerB.addr.toString(), 1n * ALGO, oracle)
    await advanceTime(fixture, 900)
    await spendCampaign(
      stack,
      campaign.appClient,
      campaign.appId,
      backerA.addr.toString(),
      0,
      2n * ALGO,
      txA,
      'refund(uint64,uint64,byte[],byte[])void',
      oracle,
    )
    await deleteCampaign(stack, campaign.appId, creator.addr.toString())
    await spendVault(stack, campaign.appId, backerB.addr.toString(), 1, 1n * ALGO, txB, oracle)

    await advanceTime(fixture, 4_000)
    await stack.vault.client.send.call({
      method: 'finalize(uint64)void',
      args: [campaign.appId],
      sender: backerA.addr,
      extraFee: microAlgos(FEE),
      suppressLog: true,
    })
    expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
  })

  test('CON-041 standalone successful claim workflow', { tags: ['happy', 'always'] }, async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const campaign = await deployCampaign(stack, creator.addr.toString(), { goal: 2n * ALGO })
    const oracle = new ClaimTreeOracle('standalone-claim-')

    await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 2n * ALGO, oracle)
    await advanceTime(fixture, 900)
    await claimCampaign(stack, campaign.appClient, campaign.appId, creator.addr.toString())
    await deleteCampaign(stack, campaign.appId, creator.addr.toString(), { vaultBoxRelease: true })

    await expect(stack.algorand.app.getById(campaign.appId)).rejects.toThrow()
    expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
  })
})
