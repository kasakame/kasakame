import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import { beforeAll, describe, expect, test } from 'vitest'
import { cancelPledge, createCampaign, deleteCampaign, fetchChainTimestamp, fetchMyLeaves, isRegistered, pledge } from '../src/index.js'
import { balanceOf, headerOf, leafAt, session, setupSdkStack, type SdkStack } from './utils/index.js'

describe('SDK open campaign (localnet)', () => {
  const fixture = algorandFixture()
  let stack: SdkStack

  beforeAll(async () => {
    stack = await setupSdkStack(fixture)
  })

  test('SDK-001 create → pledge → cancel → delete', { tags: ['smoke', 'happy', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK open campaign', 'ipfs://sdk-open', 10n * MICRO_ALGOS_PER_ALGO, deadline)
    expect(await isRegistered(appId)).toBe(true)

    const backerBefore = await balanceOf(stack.algorand, backer.address)
    await pledge(appId, backer, 2n * MICRO_ALGOS_PER_ALGO)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(2n * MICRO_ALGOS_PER_ALGO)

    const leaves = await fetchMyLeaves(appId, backer.address)
    expect(leaves).toHaveLength(1)
    const leaf = leafAt(leaves, 0)
    await cancelPledge(appId, backer, leaf)

    expect(await fetchMyLeaves(appId, backer.address)).toEqual([])
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(0n)
    // Pledge group (3 outer + credit inner) + cancel (outer + 2 payout inners + 2 OpUp takes).
    expect(await balanceOf(stack.algorand, backer.address)).toEqual(backerBefore - 4n * stack.minFee - 5n * stack.minFee)

    await deleteCampaign(appId, creator)
    expect(await isRegistered(appId)).toBe(false)
    await expect(stack.algorand.app.getById(appId)).rejects.toThrow()
  })
})
