import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO, MIN_REFUND_WINDOW_SECONDS } from '@kasakame/constants'
import { advanceTime } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  cancelPledge,
  clearCachedCampaigns,
  deleteCampaign,
  enumerateCampaigns,
  fetchChainTimestamp,
  fetchMyLeaves,
  fetchMyPledge,
  fetchVaultBox,
  fetchVaultConfig,
  finalize,
  getCachedCampaigns,
  getCampaign,
  listCampaigns,
  pledge,
  refundWindowEndsAt,
  waitForIndexerCatchUp,
} from '../src/index.js'
import {
  TEST_DEADLINE_SECONDS,
  advancePastDeadline,
  createTestCampaign,
  expectVaultBox,
  leafAt,
  session,
  setupSdkStack,
  type SdkStack,
} from './utils/index.js'

describe('SDK read path (localnet)', () => {
  const fixture = algorandFixture()
  let stack: SdkStack

  beforeAll(async () => {
    stack = await setupSdkStack(fixture)
  })

  test('SDK-070 live, deleted, and finalized reads', { tags: ['happy', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 50n)
    const deadline = (await fetchChainTimestamp()) + TEST_DEADLINE_SECONDS

    const liveGoal = MICRO_ALGOS_PER_ALGO
    const { appId: liveId } = await createTestCampaign(creator, liveGoal, {
      deadline,
      title: 'SDK read live',
      uri: 'ipfs://sdk-read-live',
    })
    const remainingAmount = 2n * MICRO_ALGOS_PER_ALGO
    await pledge(liveId, backer, remainingAmount)
    await pledge(liveId, backer, MICRO_ALGOS_PER_ALGO)
    expect(await fetchMyPledge(liveId, backer.address)).toEqual(remainingAmount + MICRO_ALGOS_PER_ALGO)

    const cancelled = leafAt(await fetchMyLeaves(liveId, backer.address), 1)
    await cancelPledge(liveId, backer, cancelled)
    expect(await fetchMyPledge(liveId, backer.address)).toEqual(remainingAmount)

    const failedGoal = 10n * MICRO_ALGOS_PER_ALGO
    const { appId: failedId } = await createTestCampaign(creator, failedGoal, {
      deadline,
      title: 'SDK read deleted',
      uri: 'ipfs://sdk-read-deleted',
    })
    const failedAmount = 2n * MICRO_ALGOS_PER_ALGO
    await pledge(failedId, backer, failedAmount)
    await advancePastDeadline(fixture)
    await deleteCampaign(failedId, creator)
    await waitForIndexerCatchUp()

    const now = await fetchChainTimestamp()
    const listed = await listCampaigns(backer.address)
    expect(listed.campaigns.map((campaign) => campaign.id)).toContain(liveId)
    expect(listed.campaigns.map((campaign) => campaign.id)).not.toContain(failedId)
    expect(listed.campaigns.find((campaign) => campaign.id === liveId)?.myPledgeMicroAlgos).toEqual(remainingAmount)
    expect(getCachedCampaigns()?.campaigns.map((campaign) => campaign.id)).toEqual(listed.campaigns.map((campaign) => campaign.id))
    clearCachedCampaigns()
    expect(getCachedCampaigns()).toBeUndefined()

    const live = await getCampaign(liveId, now, backer.address)
    expect(live).toMatchObject({
      id: liveId,
      title: 'SDK read live',
      metadataUri: 'ipfs://sdk-read-live',
      goalMicroAlgos: liveGoal,
      raisedMicroAlgos: remainingAmount,
      deadlineSeconds: deadline,
      status: 'successful',
      claimed: false,
      myPledgeMicroAlgos: remainingAmount,
    })
    expect(live?.deleted).toBeUndefined()

    const deleted = await getCampaign(failedId, now)
    expect(deleted).toMatchObject({
      id: failedId,
      title: 'SDK read deleted',
      metadataUri: 'ipfs://sdk-read-deleted',
      goalMicroAlgos: failedGoal,
      raisedMicroAlgos: failedAmount,
      deadlineSeconds: deadline,
      status: 'failed',
      deleted: true,
    })

    const enumerated = await enumerateCampaigns()
    expect(enumerated.has(liveId)).toBe(true)
    expect(enumerated.has(failedId)).toBe(true)

    const config = await fetchVaultConfig()
    expect(config.window).toEqual(BigInt(MIN_REFUND_WINDOW_SECONDS))
    expect(config.sweepTarget).toMatch(/^[A-Z2-7]{58}$/)
    expect(config.sweepTarget).not.toEqual(stack.vaultAddress)
    const box = await fetchVaultBox(failedId)
    expectVaultBox(box, { status: 2 })
    const settledAt = box?.settledAt ?? 0n
    expect(settledAt).toBeGreaterThan(0n)
    expect(refundWindowEndsAt(settledAt, config.window)).toEqual(settledAt + config.window)

    await advanceTime(fixture, MIN_REFUND_WINDOW_SECONDS + 4_000)
    await finalize(failedId, backer)
    await waitForIndexerCatchUp()
    expect(await fetchVaultBox(failedId)).toBeUndefined()
    const afterFinalize = await enumerateCampaigns()
    expect(afterFinalize.has(failedId)).toBe(false)
    expect(afterFinalize.has(liveId)).toBe(true)
  })
})
