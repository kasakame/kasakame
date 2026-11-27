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
  LARGE_TREE_SIZE,
  LARGE_TREE_TIMEOUT_MS,
  leafAt,
  session,
  setupSdkStack,
  vaultSpendFee,
  type SdkStack,
} from './utils/index.js'

describe('SDK large tree (localnet)', () => {
  const fixture = algorandFixture()
  let stack: SdkStack

  beforeAll(async () => {
    stack = await setupSdkStack(fixture)
  })

  test(
    'SDK-040 large tree → cancel and refund with a deep path',
    { tags: ['scale', 'always'], timeout: LARGE_TREE_TIMEOUT_MS },
    async () => {
      const creator = await session(fixture, 50n)
      const backer = await session(fixture, 300n)
      const { appId } = await createTestCampaign(creator, 1_000n * MICRO_ALGOS_PER_ALGO)

      for (let i = 0; i < LARGE_TREE_SIZE; i++) await pledge(appId, backer, MICRO_ALGOS_PER_ALGO)
      const initial = await fetchMyLeaves(appId, backer.address)
      expect(initial).toHaveLength(LARGE_TREE_SIZE)
      const size = BigInt(LARGE_TREE_SIZE)

      // N=255, k=9: r=c=7 (14 path elements), the heaviest shape exercised by the contract ladder.
      const leaf9 = leafAt(initial, 9)
      const backerBeforeCancel = await accountInfo(stack.algorand, backer.address)
      await cancelPledge(appId, backer, leaf9)
      const backerAfterCancel = await accountInfo(stack.algorand, backer.address)
      expect(backerAfterCancel.balance - backerBeforeCancel.balance).toEqual(leaf9.amount - campaignSpendFee(stack.minFee, size, 9n))
      expect(backerAfterCancel.minBalance).toEqual(backerBeforeCancel.minBalance)
      expect((await headerOf(appId)).raisedMicroAlgos).toEqual(BigInt(LARGE_TREE_SIZE - 1) * MICRO_ALGOS_PER_ALGO)

      await advancePastDeadline(fixture)

      const leaf10 = leafAt(await fetchMyLeaves(appId, backer.address), 10)
      const backerBeforeRefund = await accountInfo(stack.algorand, backer.address)
      await refund(appId, backer, leaf10)
      const backerAfterRefund = await accountInfo(stack.algorand, backer.address)
      expect(backerAfterRefund.balance - backerBeforeRefund.balance).toEqual(leaf10.amount - campaignSpendFee(stack.minFee, size, 10n))
      await deleteCampaign(appId, creator)

      const leaf11 = leafAt(await fetchMyLeaves(appId, backer.address), 11)
      const backerBeforeVaultRefund = await accountInfo(stack.algorand, backer.address)
      await refund(appId, backer, leaf11)
      const backerAfterVaultRefund = await accountInfo(stack.algorand, backer.address)
      expect(backerAfterVaultRefund.balance - backerBeforeVaultRefund.balance).toEqual(
        leaf11.amount - vaultSpendFee(stack.minFee, size, 11n),
      )
      expectVaultBox(await fetchVaultBox(appId), {
        paidIn: BigInt(LARGE_TREE_SIZE) * MICRO_ALGOS_PER_ALGO,
        paidOut: 3n * MICRO_ALGOS_PER_ALGO,
      })
    },
  )
})
