import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO, REGISTER_DEPOSIT_MICRO_ALGOS, VAULT_BOX_MBR_MICRO_ALGOS } from '@kasakame/constants'
import { accountInfo } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import { deleteCampaign, fetchMyLeaves, fetchVaultBox, finalize, isRegistered, pledge, refund } from '../src/index.js'
import {
  advancePastDeadline,
  campaignSpendFee,
  createTestCampaign,
  expectLeaves,
  expectVaultBox,
  headerOf,
  leafAt,
  session,
  setupSdkStack,
  vaultSpendFee,
  type SdkStack,
} from './utils/index.js'

describe('SDK failed campaign (localnet)', () => {
  const fixture = algorandFixture()
  let stack: SdkStack

  beforeAll(async () => {
    stack = await setupSdkStack(fixture)
  })

  test('SDK-020 failed campaign → refund before delete → delete → refund after delete', { tags: ['happy', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backerA = await session(fixture, 50n)
    const backerB = await session(fixture, 50n)

    const creatorBeforeCreate = await accountInfo(stack.algorand, creator.address)
    const registryBefore = await accountInfo(stack.algorand, stack.registryAddress)
    const vaultBefore = await accountInfo(stack.algorand, stack.vaultAddress)
    const { appId } = await createTestCampaign(creator, 10n * MICRO_ALGOS_PER_ALGO)
    const creatorAfterCreate = await accountInfo(stack.algorand, creator.address)
    const campaignMbr = creatorAfterCreate.minBalance - creatorBeforeCreate.minBalance

    const amountA = 3n * MICRO_ALGOS_PER_ALGO
    const amountB = 2n * MICRO_ALGOS_PER_ALGO
    const backerABeforePledge = await accountInfo(stack.algorand, backerA.address)
    await pledge(appId, backerA, amountA)
    await pledge(appId, backerB, amountB)
    const backerABeforeRefund = await accountInfo(stack.algorand, backerA.address)
    const vaultAfterPledges = await accountInfo(stack.algorand, stack.vaultAddress)
    expect(vaultAfterPledges.minBalance - vaultBefore.minBalance).toEqual(VAULT_BOX_MBR_MICRO_ALGOS)
    await advancePastDeadline(fixture)

    // Campaign refund: campaign outer + 2 payout inners + the OpUp takes for this shape.
    const leafA = leafAt(await fetchMyLeaves(appId, backerA.address), 0)
    await refund(appId, backerA, leafA)
    const backerAAfterRefund = await accountInfo(stack.algorand, backerA.address)
    expect(backerAAfterRefund.balance - backerABeforeRefund.balance).toEqual(amountA - campaignSpendFee(stack.minFee, 2n, 0n))
    expect(backerAAfterRefund.minBalance).toEqual(backerABeforePledge.minBalance)
    expectLeaves(await fetchMyLeaves(appId, backerA.address), [])
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(amountB)
    expect((await headerOf(appId)).status).toEqual('failed')

    // Delete: unregister + inner deposit + delete + 2 inners = 5 min fees; the app and registration MBRs return.
    const creatorBeforeDelete = await accountInfo(stack.algorand, creator.address)
    await deleteCampaign(appId, creator)
    const creatorAfterDelete = await accountInfo(stack.algorand, creator.address)
    expect(creatorBeforeDelete.minBalance - creatorAfterDelete.minBalance).toEqual(campaignMbr)
    expect(creatorAfterDelete.balance - creatorBeforeDelete.balance).toEqual(REGISTER_DEPOSIT_MICRO_ALGOS - 5n * stack.minFee)
    const registryAfterDelete = await accountInfo(stack.algorand, stack.registryAddress)
    expect(registryAfterDelete).toEqual(registryBefore)
    expect(await isRegistered(appId)).toBe(false)
    const settled = await fetchVaultBox(appId)
    expectVaultBox(settled, { status: 2, paidIn: amountA + amountB, paidOut: amountA })
    const deletedHeader = await headerOf(appId)
    expect(deletedHeader.deleted).toBe(true)
    expect(deletedHeader.raisedMicroAlgos).toEqual(amountB)

    // Vault refund after delete: vault outer + inner payment + the OpUp takes.
    const leafB = leafAt(await fetchMyLeaves(appId, backerB.address), 1)
    const backerBBefore = await accountInfo(stack.algorand, backerB.address)
    await refund(appId, backerB, leafB)
    const backerBAfter = await accountInfo(stack.algorand, backerB.address)
    expect(backerBAfter.balance - backerBBefore.balance).toEqual(amountB - vaultSpendFee(stack.minFee, 2n, 1n))
    expect(backerBAfter.minBalance).toEqual(backerBBefore.minBalance)
    expectLeaves(await fetchMyLeaves(appId, backerB.address), [])
    const box = await fetchVaultBox(appId)
    expectVaultBox(box, { paidIn: amountA + amountB, paidOut: amountA + amountB })

    // Finalize a fully paid-out failed box: vault outer only, releases the box MBR.
    const creatorBeforeFinalize = await accountInfo(stack.algorand, creator.address)
    await finalize(appId, creator)
    const creatorAfterFinalize = await accountInfo(stack.algorand, creator.address)
    const vaultAfterFinalize = await accountInfo(stack.algorand, stack.vaultAddress)
    expect(creatorBeforeFinalize.balance - creatorAfterFinalize.balance).toEqual(stack.minFee)
    expect(vaultAfterFinalize.minBalance).toEqual(vaultBefore.minBalance)
    expect(await fetchVaultBox(appId)).toBeUndefined()
  })
})
