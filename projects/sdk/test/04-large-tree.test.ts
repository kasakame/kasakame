import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import { accountInfo, advanceTime } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  cancelPledge,
  createCampaign,
  deleteCampaign,
  fetchChainTimestamp,
  fetchMyLeaves,
  fetchVaultBox,
  pledge,
  refund,
  refundOpUpIterations,
} from '../src/index.js'
import { headerOf, LARGE_TREE_SIZE, LARGE_TREE_TIMEOUT_MS, leafAt, session, setupSdkStack, type SdkStack } from './utils/index.js'

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
      const deadline = (await fetchChainTimestamp()) + 90_000n
      const { appId } = await createCampaign(creator, 'SDK large campaign', 'ipfs://sdk-large', 1_000n * MICRO_ALGOS_PER_ALGO, deadline)

      for (let i = 0; i < LARGE_TREE_SIZE; i++) await pledge(appId, backer, MICRO_ALGOS_PER_ALGO)
      const initial = await fetchMyLeaves(appId, backer.address)
      expect(initial).toHaveLength(LARGE_TREE_SIZE)
      const size = BigInt(LARGE_TREE_SIZE)

      // N=255, k=9: r=c=7 (14 path elements), the heaviest shape exercised by the contract ladder.
      const leaf9 = leafAt(initial, 9)
      const cancelTakes = refundOpUpIterations(size, 9n)
      const backerBeforeCancel = await accountInfo(stack.algorand, backer.address)
      await cancelPledge(appId, backer, leaf9)
      const backerAfterCancel = await accountInfo(stack.algorand, backer.address)
      expect(backerAfterCancel.balance - backerBeforeCancel.balance).toEqual(leaf9.amount - (3n + BigInt(cancelTakes)) * stack.minFee)
      expect(backerAfterCancel.minBalance).toEqual(backerBeforeCancel.minBalance)
      expect((await headerOf(appId)).raisedMicroAlgos).toEqual(BigInt(LARGE_TREE_SIZE - 1) * MICRO_ALGOS_PER_ALGO)

      await advanceTime(fixture, 90_001)

      const leaf10 = leafAt(await fetchMyLeaves(appId, backer.address), 10)
      const refundTakes = refundOpUpIterations(size, 10n)
      const backerBeforeRefund = await accountInfo(stack.algorand, backer.address)
      await refund(appId, backer, leaf10)
      const backerAfterRefund = await accountInfo(stack.algorand, backer.address)
      expect(backerAfterRefund.balance - backerBeforeRefund.balance).toEqual(leaf10.amount - (3n + BigInt(refundTakes)) * stack.minFee)
      await deleteCampaign(appId, creator)

      const leaf11 = leafAt(await fetchMyLeaves(appId, backer.address), 11)
      const vaultTakes = refundOpUpIterations(size, 11n)
      const backerBeforeVaultRefund = await accountInfo(stack.algorand, backer.address)
      await refund(appId, backer, leaf11)
      const backerAfterVaultRefund = await accountInfo(stack.algorand, backer.address)
      expect(backerAfterVaultRefund.balance - backerBeforeVaultRefund.balance).toEqual(
        leaf11.amount - (2n + BigInt(vaultTakes)) * stack.minFee,
      )
      const box = await fetchVaultBox(appId)
      expect(box?.paidIn).toEqual(BigInt(LARGE_TREE_SIZE) * MICRO_ALGOS_PER_ALGO)
      expect(box?.paidOut).toEqual(3n * MICRO_ALGOS_PER_ALGO)
    },
  )
})
