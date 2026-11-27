import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import { assertRejectedUnchanged } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import { cancelPledge, fetchMyLeaves, fetchVaultBox, pledge, refund, SdkError } from '../src/index.js'
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
      (error: unknown) => {
        expect(error).toBeInstanceOf(SdkError)
        expect(error).toMatchObject({ type: 'chain-state', code: 'creator-self-pledge', operation: 'pledge', appId })
        expect((error as Error).message).toMatch(/creator cannot pledge to their own campaign/)
        return true
      },
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

    await assertRejectedUnchanged(
      () => cancelPledge(appId, backer, leaf),
      snapshot,
      (error: unknown) => {
        expect(error).toBeInstanceOf(SdkError)
        expect(error).toMatchObject({ type: 'chain-state', code: 'pledging-closed', operation: 'cancelPledge', appId })
        expect((error as Error).message).toMatch(/pledging is closed/)
        return true
      },
    )
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

    await assertRejectedUnchanged(
      () => refund(appId, backer, leaf),
      snapshot,
      (error: unknown) => {
        expect(error).toBeInstanceOf(SdkError)
        expect(error).toMatchObject({ type: 'chain-state', code: 'deadline-not-passed', operation: 'refund', appId })
        expect((error as Error).message).toMatch(/deadline has not passed/)
        return true
      },
    )
    expect(await snapshot()).toEqual({ leaves: [leaf], box: boxBefore, raised: amount })
  })

  test('SDK-103 a second refund of a spent leaf reports a stale proof', { tags: ['bad', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 50n)
    const { appId } = await createTestCampaign(creator, 10n * MICRO_ALGOS_PER_ALGO)
    const amount = 2n * MICRO_ALGOS_PER_ALGO
    await pledge(appId, backer, amount)
    const leaf = leafAt(await fetchMyLeaves(appId, backer.address), 0)
    await advancePastDeadline(fixture)
    await refund(appId, backer, leaf)

    const error = await refund(appId, backer, leaf).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SdkError)
    expect(error).toMatchObject({ type: 'stale-proof', code: 'stale-proof', operation: 'refund', appId })
    expect((error as Error).message).toMatch(/proof does not match root|stale or forged frontier/)
  })
})
