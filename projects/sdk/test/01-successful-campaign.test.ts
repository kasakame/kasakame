import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO, REGISTER_DEPOSIT_MICRO_ALGOS, VAULT_BOX_MBR_MICRO_ALGOS } from '@kasakame/constants'
import { accountInfo } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import { claim, deleteCampaign, fetchVaultBox, isRegistered, pledge } from '../src/index.js'
import { advancePastDeadline, createTestCampaign, expectVaultBox, headerOf, session, setupSdkStack, type SdkStack } from './utils/index.js'

describe('SDK successful campaign (localnet)', () => {
  const fixture = algorandFixture()
  let stack: SdkStack

  beforeAll(async () => {
    stack = await setupSdkStack(fixture)
  })

  test('SDK-010 successful campaign → claim → delete', { tags: ['happy', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 50n)

    const creatorBeforeCreate = await accountInfo(stack.algorand, creator.address)
    const registryBefore = await accountInfo(stack.algorand, stack.registryAddress)
    const vaultBefore = await accountInfo(stack.algorand, stack.vaultAddress)
    const { appId } = await createTestCampaign(creator, MICRO_ALGOS_PER_ALGO)
    const creatorAfterCreate = await accountInfo(stack.algorand, creator.address)
    const campaignMbr = creatorAfterCreate.minBalance - creatorBeforeCreate.minBalance
    expect(creatorBeforeCreate.balance - creatorAfterCreate.balance - REGISTER_DEPOSIT_MICRO_ALGOS).toEqual(3n * stack.minFee)

    await pledge(appId, backer, MICRO_ALGOS_PER_ALGO)
    const vaultAfterPledge = await accountInfo(stack.algorand, stack.vaultAddress)
    expect(vaultAfterPledge.minBalance - vaultBefore.minBalance).toEqual(VAULT_BOX_MBR_MICRO_ALGOS)
    await advancePastDeadline(fixture)

    // Claim: campaign outer + inner payClaim + inner payment = 3 min fees.
    const creatorBeforeClaim = await accountInfo(stack.algorand, creator.address)
    await claim(appId, creator)
    const creatorAfterClaim = await accountInfo(stack.algorand, creator.address)
    expect(creatorAfterClaim.balance - creatorBeforeClaim.balance).toEqual(MICRO_ALGOS_PER_ALGO - 3n * stack.minFee)
    expect(creatorAfterClaim.minBalance).toEqual(creatorBeforeClaim.minBalance)
    expect((await headerOf(appId)).status).toEqual('claimed')
    expectVaultBox(await fetchVaultBox(appId), {
      status: 3,
      paidIn: MICRO_ALGOS_PER_ALGO,
      paidOut: MICRO_ALGOS_PER_ALGO,
    })

    // Delete: unregister + inner deposit + delete + 2 inners = 5 min fees; the deposit returns and the claimed box is released.
    const creatorBeforeDelete = await accountInfo(stack.algorand, creator.address)
    await deleteCampaign(appId, creator)
    const creatorAfterDelete = await accountInfo(stack.algorand, creator.address)
    expect(creatorBeforeDelete.minBalance - creatorAfterDelete.minBalance).toEqual(campaignMbr)
    expect(creatorAfterDelete.balance - creatorBeforeDelete.balance).toEqual(REGISTER_DEPOSIT_MICRO_ALGOS - 5n * stack.minFee)
    const registryAfterDelete = await accountInfo(stack.algorand, stack.registryAddress)
    const vaultAfterDelete = await accountInfo(stack.algorand, stack.vaultAddress)
    expect(registryAfterDelete).toEqual(registryBefore)
    expect(vaultAfterDelete.minBalance).toEqual(vaultBefore.minBalance)

    expect(await isRegistered(appId)).toBe(false)
    expect(await fetchVaultBox(appId)).toBeUndefined()
    await expect(stack.algorand.app.getById(appId)).rejects.toThrow()
  })
})
