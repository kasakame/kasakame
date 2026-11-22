import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import { advanceTime } from '@kasakame/utils/testing'
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
} from '../src/index.js'
import { headerOf, leafAt, MID_TREE_SIZE, session, setupSdkStack } from './utils/index.js'

describe('SDK mid-size tree (localnet)', () => {
  const fixture = algorandFixture()

  beforeAll(async () => {
    await setupSdkStack(fixture)
  })

  test('SDK-030 mid-size tree → cancel and refund on both paths', { tags: ['scale', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 100n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK mid-size campaign', 'ipfs://sdk-mid', 100n * MICRO_ALGOS_PER_ALGO, deadline)

    for (let i = 0; i < MID_TREE_SIZE; i++) await pledge(appId, backer, MICRO_ALGOS_PER_ALGO)
    const initial = await fetchMyLeaves(appId, backer.address)
    expect(initial).toHaveLength(MID_TREE_SIZE)

    // N=47, k=0: r=5, c=4 (nine path elements), so the cancel needs several OpUp takes.
    const leaf0 = leafAt(initial, 0)
    await cancelPledge(appId, backer, leaf0)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(BigInt(MID_TREE_SIZE - 1) * MICRO_ALGOS_PER_ALGO)

    await advanceTime(fixture, 90_001)

    const leaf1 = leafAt(await fetchMyLeaves(appId, backer.address), 1)
    await refund(appId, backer, leaf1)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(BigInt(MID_TREE_SIZE - 2) * MICRO_ALGOS_PER_ALGO)
    expect((await headerOf(appId)).status).toEqual('failed')

    await deleteCampaign(appId, creator)

    const leaf2 = leafAt(await fetchMyLeaves(appId, backer.address), 2)
    await refund(appId, backer, leaf2)
    const box = await fetchVaultBox(appId)
    expect(box?.paidIn).toEqual(BigInt(MID_TREE_SIZE) * MICRO_ALGOS_PER_ALGO)
    expect(box?.paidOut).toEqual(3n * MICRO_ALGOS_PER_ALGO)
  })
})
