import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import { balanceOf } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  createCampaign,
  deleteCampaign,
  fetchChainTimestamp,
  fetchMyLeaves,
  fetchVaultBox,
  isRegistered,
  pledge,
  refund,
} from '../src/index.js'
import { advanceTime, headerOf, leafAt, session, setupSdkStack, type SdkStack } from './utils/index.js'

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
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK failed campaign', 'ipfs://sdk-failed', 10n * MICRO_ALGOS_PER_ALGO, deadline)

    await pledge(appId, backerA, 3n * MICRO_ALGOS_PER_ALGO)
    await pledge(appId, backerB, 2n * MICRO_ALGOS_PER_ALGO)
    await advanceTime(fixture, 90_001)

    const leafA = leafAt(await fetchMyLeaves(appId, backerA.address), 0)
    const backerABefore = await balanceOf(stack.algorand, backerA.address)
    await refund(appId, backerA, leafA)
    expect(await balanceOf(stack.algorand, backerA.address)).toEqual(backerABefore + 3n * MICRO_ALGOS_PER_ALGO - 5n * stack.minFee)
    expect(await fetchMyLeaves(appId, backerA.address)).toEqual([])
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(2n * MICRO_ALGOS_PER_ALGO)
    expect((await headerOf(appId)).status).toEqual('failed')

    await deleteCampaign(appId, creator)
    expect(await isRegistered(appId)).toBe(false)
    const settled = await fetchVaultBox(appId)
    expect(settled?.status).toEqual(2)
    expect(settled?.paidIn).toEqual(5n * MICRO_ALGOS_PER_ALGO)
    expect(settled?.paidOut).toEqual(3n * MICRO_ALGOS_PER_ALGO)
    const deletedHeader = await headerOf(appId)
    expect(deletedHeader.deleted).toBe(true)
    expect(deletedHeader.raisedMicroAlgos).toEqual(2n * MICRO_ALGOS_PER_ALGO)

    const leafB = leafAt(await fetchMyLeaves(appId, backerB.address), 0)
    const backerBBefore = await balanceOf(stack.algorand, backerB.address)
    await refund(appId, backerB, leafB)
    expect(await balanceOf(stack.algorand, backerB.address)).toEqual(backerBBefore + 2n * MICRO_ALGOS_PER_ALGO - 4n * stack.minFee)
    expect(await fetchMyLeaves(appId, backerB.address)).toEqual([])
    const box = await fetchVaultBox(appId)
    expect(box?.paidIn).toEqual(5n * MICRO_ALGOS_PER_ALGO)
    expect(box?.paidOut).toEqual(5n * MICRO_ALGOS_PER_ALGO)
  })
})
