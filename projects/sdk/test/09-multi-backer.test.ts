import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import { accountInfo } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import { cancelPledge, deleteCampaign, fetchMyLeaves, fetchMyPledge, fetchVaultBox, pledge, refund } from '../src/index.js'
import {
  advancePastDeadline,
  campaignSpendFee,
  createTestCampaign,
  expectLeaves,
  expectVaultBox,
  headerOf,
  leafAt,
  pledgeFee,
  session,
  setupSdkStack,
  vaultSpendFee,
  type SdkStack,
} from './utils/index.js'

describe('SDK multi-backer (localnet)', () => {
  const fixture = algorandFixture()
  let stack: SdkStack

  beforeAll(async () => {
    stack = await setupSdkStack(fixture)
  })

  test('SDK-090 interleaved leaves, cancels, and refunds across backers', { tags: ['happy', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backerA = await session(fixture, 50n)
    const backerB = await session(fixture, 50n)
    const backerC = await session(fixture, 50n)
    const initialA = await accountInfo(stack.algorand, backerA.address)
    const initialB = await accountInfo(stack.algorand, backerB.address)
    const initialC = await accountInfo(stack.algorand, backerC.address)
    const { appId } = await createTestCampaign(creator, 15n * MICRO_ALGOS_PER_ALGO)

    const a1 = 3n * MICRO_ALGOS_PER_ALGO
    const a2 = MICRO_ALGOS_PER_ALGO
    const b1 = 2n * MICRO_ALGOS_PER_ALGO
    const b2 = 2n * MICRO_ALGOS_PER_ALGO
    const c1 = MICRO_ALGOS_PER_ALGO
    const c2 = MICRO_ALGOS_PER_ALGO
    const c3 = MICRO_ALGOS_PER_ALGO
    await pledge(appId, backerA, a1)
    await pledge(appId, backerB, b1)
    await pledge(appId, backerA, a2)
    await pledge(appId, backerB, b2)
    await pledge(appId, backerC, c1)
    await pledge(appId, backerC, c2)
    await pledge(appId, backerC, c3)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(a1 + a2 + b1 + b2 + c1 + c2 + c3)

    const treeSize = 7n
    const pledgeCost = (position: number): bigint => pledgeFee(stack.minFee, BigInt(position))
    const campaignCost = (position: number): bigint => campaignSpendFee(stack.minFee, treeSize, BigInt(position))
    const vaultCost = (position: number): bigint => vaultSpendFee(stack.minFee, treeSize, BigInt(position))

    const cancelA = leafAt(await fetchMyLeaves(appId, backerA.address), 2)
    const aBeforeCancel = await accountInfo(stack.algorand, backerA.address)
    await cancelPledge(appId, backerA, cancelA)
    const aAfterCancel = await accountInfo(stack.algorand, backerA.address)
    expect(aAfterCancel.balance - aBeforeCancel.balance).toEqual(cancelA.amount - campaignCost(cancelA.position))
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(a1 + b1 + b2 + c1 + c2 + c3)

    const cancelB = leafAt(await fetchMyLeaves(appId, backerB.address), 3)
    const bBeforeCancel = await accountInfo(stack.algorand, backerB.address)
    await cancelPledge(appId, backerB, cancelB)
    const bAfterCancel = await accountInfo(stack.algorand, backerB.address)
    expect(bAfterCancel.balance - bBeforeCancel.balance).toEqual(cancelB.amount - campaignCost(cancelB.position))
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(a1 + b1 + c1 + c2 + c3)

    const livePositions = async (): Promise<{ a: number[]; b: number[]; c: number[] }> => ({
      a: (await fetchMyLeaves(appId, backerA.address)).map((leaf) => leaf.position),
      b: (await fetchMyLeaves(appId, backerB.address)).map((leaf) => leaf.position),
      c: (await fetchMyLeaves(appId, backerC.address)).map((leaf) => leaf.position),
    })
    expect(await livePositions()).toEqual({ a: [0], b: [1], c: [4, 5, 6] })
    expect(await fetchMyPledge(appId, backerA.address)).toEqual(a1)
    expect(await fetchMyPledge(appId, backerB.address)).toEqual(b1)
    expect(await fetchMyPledge(appId, backerC.address)).toEqual(c1 + c2 + c3)

    await advancePastDeadline(fixture)

    // Campaign path while the box is open: one leaf from each backer, interleaved.
    const refundA = leafAt(await fetchMyLeaves(appId, backerA.address), 0)
    const aBeforeRefund = await accountInfo(stack.algorand, backerA.address)
    await refund(appId, backerA, refundA)
    const aAfterRefund = await accountInfo(stack.algorand, backerA.address)
    expect(aAfterRefund.balance - aBeforeRefund.balance).toEqual(refundA.amount - campaignCost(refundA.position))
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(b1 + c1 + c2 + c3)

    const refundC = leafAt(await fetchMyLeaves(appId, backerC.address), 4)
    const cBeforeRefund = await accountInfo(stack.algorand, backerC.address)
    await refund(appId, backerC, refundC)
    const cAfterRefund = await accountInfo(stack.algorand, backerC.address)
    expect(cAfterRefund.balance - cBeforeRefund.balance).toEqual(refundC.amount - campaignCost(refundC.position))
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(b1 + c2 + c3)

    const refundB = leafAt(await fetchMyLeaves(appId, backerB.address), 1)
    const bBeforeRefund = await accountInfo(stack.algorand, backerB.address)
    await refund(appId, backerB, refundB)
    const bAfterRefund = await accountInfo(stack.algorand, backerB.address)
    expect(bAfterRefund.balance - bBeforeRefund.balance).toEqual(refundB.amount - campaignCost(refundB.position))
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(c2 + c3)
    expect(await livePositions()).toEqual({ a: [], b: [], c: [5, 6] })
    expect(await fetchMyPledge(appId, backerA.address)).toBeUndefined()
    expect(await fetchMyPledge(appId, backerB.address)).toBeUndefined()
    expect(await fetchMyPledge(appId, backerC.address)).toEqual(c2 + c3)

    await deleteCampaign(appId, creator)
    expectVaultBox(await fetchVaultBox(appId), {
      status: 2,
      paidIn: a1 + a2 + b1 + b2 + c1 + c2 + c3,
      paidOut: a1 + a2 + b1 + b2 + c1,
    })
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(c2 + c3)

    // Vault path after delete: the remaining leaves.
    const remainingC1 = leafAt(await fetchMyLeaves(appId, backerC.address), 5)
    const cBeforeVault1 = await accountInfo(stack.algorand, backerC.address)
    await refund(appId, backerC, remainingC1)
    const cAfterVault1 = await accountInfo(stack.algorand, backerC.address)
    expect(cAfterVault1.balance - cBeforeVault1.balance).toEqual(remainingC1.amount - vaultCost(remainingC1.position))
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(c3)

    const remainingC2 = leafAt(await fetchMyLeaves(appId, backerC.address), 6)
    const cBeforeVault2 = await accountInfo(stack.algorand, backerC.address)
    await refund(appId, backerC, remainingC2)
    const cAfterVault2 = await accountInfo(stack.algorand, backerC.address)
    expect(cAfterVault2.balance - cBeforeVault2.balance).toEqual(remainingC2.amount - vaultCost(remainingC2.position))
    expectLeaves(await fetchMyLeaves(appId, backerC.address), [])
    expect(await fetchMyPledge(appId, backerC.address)).toBeUndefined()
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(0n)
    expectVaultBox(await fetchVaultBox(appId), {
      paidIn: a1 + a2 + b1 + b2 + c1 + c2 + c3,
      paidOut: a1 + a2 + b1 + b2 + c1 + c2 + c3,
    })

    // Every principal returned; each backer keeps the initial balance minus only the fees they paid.
    const feesA = pledgeCost(0) + pledgeCost(2) + campaignCost(cancelA.position) + campaignCost(refundA.position)
    const feesB = pledgeCost(1) + pledgeCost(3) + campaignCost(cancelB.position) + campaignCost(refundB.position)
    const feesC =
      pledgeCost(4) +
      pledgeCost(5) +
      pledgeCost(6) +
      campaignCost(refundC.position) +
      vaultCost(remainingC1.position) +
      vaultCost(remainingC2.position)
    const finalA = await accountInfo(stack.algorand, backerA.address)
    const finalB = await accountInfo(stack.algorand, backerB.address)
    const finalC = await accountInfo(stack.algorand, backerC.address)
    expect(finalA.balance).toEqual(initialA.balance - feesA)
    expect(finalB.balance).toEqual(initialB.balance - feesB)
    expect(finalC.balance).toEqual(initialC.balance - feesC)
    expect(finalA.minBalance).toEqual(initialA.minBalance)
    expect(finalB.minBalance).toEqual(initialB.minBalance)
    expect(finalC.minBalance).toEqual(initialC.minBalance)
  })
})
