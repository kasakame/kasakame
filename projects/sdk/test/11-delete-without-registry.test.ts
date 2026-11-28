import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO, REGISTER_DEPOSIT_MICRO_ALGOS } from '@kasakame/constants'
import { accountInfo, assertAccountDelta } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import { configureSdk, deleteCampaign, isRegistered } from '../src/index.js'
import { createTestCampaign, session, setupSdkStack, type SdkStack } from './utils/index.js'

describe('SDK delete without a configured Registry (localnet)', () => {
  const fixture = algorandFixture()
  let stack: SdkStack

  beforeAll(async () => {
    stack = await setupSdkStack(fixture)
  })

  test('SDK-110 deletes a registered campaign by reading the vault Registry', { tags: ['happy', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const registryBefore = await accountInfo(stack.algorand, stack.registryAddress)
    const beforeCreate = await accountInfo(stack.algorand, creator.address)
    const { appId } = await createTestCampaign(creator, 10n * MICRO_ALGOS_PER_ALGO)
    const afterCreate = await accountInfo(stack.algorand, creator.address)
    const campaignMbr = afterCreate.minBalance - beforeCreate.minBalance

    configureSdk({ algorand: stack.algorand, registryAppId: 0n, vaultAppId: stack.vaultAppId })
    const beforeDelete = await accountInfo(stack.algorand, creator.address)
    await deleteCampaign(appId, creator)
    const afterDelete = await accountInfo(stack.algorand, creator.address)

    // Unregister (2 fees) + delete (3 fees); the deposit and campaign MBR return.
    assertAccountDelta('creator', beforeDelete, afterDelete, {
      balance: REGISTER_DEPOSIT_MICRO_ALGOS - 5n * stack.minFee,
      minBalance: -campaignMbr,
    })
    expect(await accountInfo(stack.algorand, stack.registryAddress)).toEqual(registryBefore)
    await expect(stack.algorand.app.getById(appId)).rejects.toThrow()

    configureSdk({ algorand: stack.algorand, registryAppId: stack.registryAppId, vaultAppId: stack.vaultAppId })
    expect(await isRegistered(appId)).toBe(false)
  })

  test('SDK-111 an unregistered campaign deletes with a no-op unregister', { tags: ['happy', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    configureSdk({ algorand: stack.algorand, registryAppId: 0n, vaultAppId: stack.vaultAppId })
    const registryBefore = await accountInfo(stack.algorand, stack.registryAddress)
    const beforeCreate = await accountInfo(stack.algorand, creator.address)
    const { appId } = await createTestCampaign(creator, 10n * MICRO_ALGOS_PER_ALGO)
    const afterCreate = await accountInfo(stack.algorand, creator.address)
    const campaignMbr = afterCreate.minBalance - beforeCreate.minBalance

    const beforeDelete = await accountInfo(stack.algorand, creator.address)
    await deleteCampaign(appId, creator)
    const afterDelete = await accountInfo(stack.algorand, creator.address)

    // The Registry has no box for this campaign, so unregister is a no-op and only the fees move.
    assertAccountDelta('creator', beforeDelete, afterDelete, { balance: -5n * stack.minFee, minBalance: -campaignMbr })
    expect(await accountInfo(stack.algorand, stack.registryAddress)).toEqual(registryBefore)
    await expect(stack.algorand.app.getById(appId)).rejects.toThrow()

    configureSdk({ algorand: stack.algorand, registryAppId: stack.registryAppId, vaultAppId: stack.vaultAppId })
    expect(await isRegistered(appId)).toBe(false)
  })
})
