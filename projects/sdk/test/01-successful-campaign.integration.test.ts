import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import { beforeAll, describe, expect, test } from 'vitest'
import { claim, createCampaign, deleteCampaign, fetchChainTimestamp, fetchVaultBox, isRegistered, pledge } from '../src/index.js'
import { advanceTime, balanceOf, headerOf, session, setupSdkStack, type SdkStack } from './utils/index.js'

describe('SDK successful campaign (localnet)', () => {
  const fixture = algorandFixture()
  let stack: SdkStack

  beforeAll(async () => {
    stack = await setupSdkStack(fixture)
  })

  test('SDK-010 successful campaign → claim → delete', { tags: ['happy', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK successful campaign', 'ipfs://sdk-success', MICRO_ALGOS_PER_ALGO, deadline)

    await pledge(appId, backer, MICRO_ALGOS_PER_ALGO)
    await advanceTime(fixture, 90_001)

    const creatorBefore = await balanceOf(stack.algorand, creator.address)
    await claim(appId, creator)
    expect(await balanceOf(stack.algorand, creator.address)).toEqual(creatorBefore + MICRO_ALGOS_PER_ALGO - 3n * stack.minFee)
    expect((await headerOf(appId)).status).toEqual('claimed')
    const box = await fetchVaultBox(appId)
    expect(box?.status).toEqual(3)
    expect(box?.paidIn).toEqual(MICRO_ALGOS_PER_ALGO)
    expect(box?.paidOut).toEqual(MICRO_ALGOS_PER_ALGO)

    await deleteCampaign(appId, creator)
    expect(await isRegistered(appId)).toBe(false)
    expect(await fetchVaultBox(appId)).toBeUndefined()
    await expect(stack.algorand.app.getById(appId)).rejects.toThrow()
  })
})
