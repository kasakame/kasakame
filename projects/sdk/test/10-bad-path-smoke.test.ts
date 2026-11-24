import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import { assertRejectedUnchanged } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import { cancelPledge, fetchMyLeaves, fetchVaultBox, pledge, refund } from '../src/index.js'
import { advancePastDeadline, campaignSnapshot, createTestCampaign, leafAt, session, setupSdkStack } from './utils/index.js'

describe('SDK bad-path smoke (localnet)', () => {
  const fixture = algorandFixture()

  beforeAll(async () => {
    await setupSdkStack(fixture)
  })

  test('SDK-100 creator pledge is rejected without creating a leaf or box', { tags: ['bad', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const { appId } = await createTestCampaign(creator, 10n * MICRO_ALGOS_PER_ALGO)
    const snapshot = () => campaignSnapshot(appId, creator.address)
    expect(await snapshot()).toEqual({ leaves: [], box: undefined, raised: 0n })

    await assertRejectedUnchanged(
      () => pledge(appId, creator, MICRO_ALGOS_PER_ALGO),
      snapshot,
      /creator cannot pledge to their own campaign/,
    )
    expect(await snapshot()).toEqual({ leaves: [], box: undefined, raised: 0n })
  })

  test('SDK-101 post-deadline cancel is rejected and keeps the leaf', { tags: ['bad', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 50n)
    const { appId } = await createTestCampaign(creator, 10n * MICRO_ALGOS_PER_ALGO)
    const amount = 2n * MICRO_ALGOS_PER_ALGO
    await pledge(appId, backer, amount)
    const leaf = leafAt(await fetchMyLeaves(appId, backer.address), 0)
    const boxBefore = await fetchVaultBox(appId)
    await advancePastDeadline(fixture)
    const snapshot = () => campaignSnapshot(appId, backer.address)

    await assertRejectedUnchanged(() => cancelPledge(appId, backer, leaf), snapshot, /pledging is closed/)
    expect(await snapshot()).toEqual({ leaves: [leaf], box: boxBefore, raised: amount })
  })

  test('SDK-102 pre-deadline refund is rejected without routing to the vault', { tags: ['bad', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 50n)
    const { appId } = await createTestCampaign(creator, 10n * MICRO_ALGOS_PER_ALGO)
    const amount = 2n * MICRO_ALGOS_PER_ALGO
    await pledge(appId, backer, amount)
    const leaf = leafAt(await fetchMyLeaves(appId, backer.address), 0)
    const boxBefore = await fetchVaultBox(appId)
    expect(boxBefore?.status).toEqual(1)
    expect(boxBefore?.paidOut).toEqual(0n)
    const snapshot = () => campaignSnapshot(appId, backer.address)

    await assertRejectedUnchanged(() => refund(appId, backer, leaf), snapshot, /deadline has not passed/)
    expect(await snapshot()).toEqual({ leaves: [leaf], box: boxBefore, raised: amount })
  })
})
