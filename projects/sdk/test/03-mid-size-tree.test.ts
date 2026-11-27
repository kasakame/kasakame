import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import { accountInfo } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import { cancelPledge, deleteCampaign, fetchMyLeaves, fetchVaultBox, pledge, refund } from '../src/index.js'
import {
  advancePastDeadline,
  campaignSpendFee,
  createTestCampaign,
  expectVaultBox,
  headerOf,
  leafAt,
  MID_TREE_SIZE,
  session,
  setupSdkStack,
  vaultSpendFee,
  type SdkStack,
} from './utils/index.js'

describe('SDK mid-size tree (localnet)', () => {
  const fixture = algorandFixture()
  let stack: SdkStack

  beforeAll(async () => {
    stack = await setupSdkStack(fixture)
  })

  test('SDK-030 mid-size tree → cancel and refund on both paths', { tags: ['scale', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 100n)
    const { appId } = await createTestCampaign(creator, 100n * MICRO_ALGOS_PER_ALGO)

    for (let i = 0; i < MID_TREE_SIZE; i++) await pledge(appId, backer, MICRO_ALGOS_PER_ALGO)
    const initial = await fetchMyLeaves(appId, backer.address)
    expect(initial).toHaveLength(MID_TREE_SIZE)
    const size = BigInt(MID_TREE_SIZE)

    // N=47, k=0: r=5, c=4 (nine path elements), so the cancel needs several OpUp takes.
    const leaf0 = leafAt(initial, 0)
    const backerBeforeCancel = await accountInfo(stack.algorand, backer.address)
    await cancelPledge(appId, backer, leaf0)
    const backerAfterCancel = await accountInfo(stack.algorand, backer.address)
    expect(backerAfterCancel.balance - backerBeforeCancel.balance).toEqual(leaf0.amount - campaignSpendFee(stack.minFee, size, 0n))
    expect(backerAfterCancel.minBalance).toEqual(backerBeforeCancel.minBalance)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(BigInt(MID_TREE_SIZE - 1) * MICRO_ALGOS_PER_ALGO)

    await advancePastDeadline(fixture)

    const leaf1 = leafAt(await fetchMyLeaves(appId, backer.address), 1)
    const backerBeforeRefund = await accountInfo(stack.algorand, backer.address)
    await refund(appId, backer, leaf1)
    const backerAfterRefund = await accountInfo(stack.algorand, backer.address)
    expect(backerAfterRefund.balance - backerBeforeRefund.balance).toEqual(leaf1.amount - campaignSpendFee(stack.minFee, size, 1n))
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(BigInt(MID_TREE_SIZE - 2) * MICRO_ALGOS_PER_ALGO)
    expect((await headerOf(appId)).status).toEqual('failed')

    await deleteCampaign(appId, creator)

    const leaf2 = leafAt(await fetchMyLeaves(appId, backer.address), 2)
    const backerBeforeVaultRefund = await accountInfo(stack.algorand, backer.address)
    await refund(appId, backer, leaf2)
    const backerAfterVaultRefund = await accountInfo(stack.algorand, backer.address)
    expect(backerAfterVaultRefund.balance - backerBeforeVaultRefund.balance).toEqual(leaf2.amount - vaultSpendFee(stack.minFee, size, 2n))
    expect(backerAfterVaultRefund.minBalance).toEqual(backerBeforeVaultRefund.minBalance)
    expectVaultBox(await fetchVaultBox(appId), {
      paidIn: BigInt(MID_TREE_SIZE) * MICRO_ALGOS_PER_ALGO,
      paidOut: 3n * MICRO_ALGOS_PER_ALGO,
    })
  })
})
