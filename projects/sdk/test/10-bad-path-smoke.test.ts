import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import { advanceTime } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import { cancelPledge, createCampaign, fetchChainTimestamp, fetchMyLeaves, fetchVaultBox, pledge, refund } from '../src/index.js'
import { headerOf, leafAt, session, setupSdkStack } from './utils/index.js'

describe('SDK bad-path smoke (localnet)', () => {
  const fixture = algorandFixture()

  beforeAll(async () => {
    await setupSdkStack(fixture)
  })

  test('SDK-100 creator pledge is rejected without creating a leaf or box', { tags: ['bad', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(
      creator,
      'SDK bad creator pledge',
      'ipfs://sdk-bad-creator',
      10n * MICRO_ALGOS_PER_ALGO,
      deadline,
    )
    expect(await fetchVaultBox(appId)).toBeUndefined()

    await expect(pledge(appId, creator, MICRO_ALGOS_PER_ALGO)).rejects.toThrow(/creator cannot pledge to their own campaign/)

    expect(await fetchMyLeaves(appId, creator.address)).toEqual([])
    expect(await fetchVaultBox(appId)).toBeUndefined()
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(0n)
  })

  test('SDK-101 post-deadline cancel is rejected and keeps the leaf', { tags: ['bad', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(
      creator,
      'SDK bad late cancel',
      'ipfs://sdk-bad-late-cancel',
      10n * MICRO_ALGOS_PER_ALGO,
      deadline,
    )
    const amount = 2n * MICRO_ALGOS_PER_ALGO
    await pledge(appId, backer, amount)
    const leaf = leafAt(await fetchMyLeaves(appId, backer.address), 0)
    const boxBefore = await fetchVaultBox(appId)
    await advanceTime(fixture, 90_001)

    await expect(cancelPledge(appId, backer, leaf)).rejects.toThrow(/pledging is closed/)

    expect(await fetchMyLeaves(appId, backer.address)).toEqual([leaf])
    expect(await fetchVaultBox(appId)).toEqual(boxBefore)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(amount)
  })

  test('SDK-102 pre-deadline refund is rejected without routing to the vault', { tags: ['bad', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(
      creator,
      'SDK bad early refund',
      'ipfs://sdk-bad-early-refund',
      10n * MICRO_ALGOS_PER_ALGO,
      deadline,
    )
    const amount = 2n * MICRO_ALGOS_PER_ALGO
    await pledge(appId, backer, amount)
    const leaf = leafAt(await fetchMyLeaves(appId, backer.address), 0)
    const boxBefore = await fetchVaultBox(appId)
    expect(boxBefore?.status).toEqual(1)
    expect(boxBefore?.paidOut).toEqual(0n)

    await expect(refund(appId, backer, leaf)).rejects.toThrow(/deadline has not passed/)

    expect(await fetchMyLeaves(appId, backer.address)).toEqual([leaf])
    expect(await fetchVaultBox(appId)).toEqual(boxBefore)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(amount)
  })
})
