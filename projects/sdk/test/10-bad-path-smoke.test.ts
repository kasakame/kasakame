import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import { advanceTime, assertRejectedUnchanged } from '@kasakame/utils/testing'
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
    const snapshot = async () => ({
      leaves: await fetchMyLeaves(appId, creator.address),
      box: await fetchVaultBox(appId),
      raised: (await headerOf(appId)).raisedMicroAlgos,
    })
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
    const snapshot = async () => ({
      leaves: await fetchMyLeaves(appId, backer.address),
      box: await fetchVaultBox(appId),
      raised: (await headerOf(appId)).raisedMicroAlgos,
    })

    await assertRejectedUnchanged(() => cancelPledge(appId, backer, leaf), snapshot, /pledging is closed/)
    expect(await snapshot()).toEqual({ leaves: [leaf], box: boxBefore, raised: amount })
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
    const snapshot = async () => ({
      leaves: await fetchMyLeaves(appId, backer.address),
      box: await fetchVaultBox(appId),
      raised: (await headerOf(appId)).raisedMicroAlgos,
    })

    await assertRejectedUnchanged(() => refund(appId, backer, leaf), snapshot, /deadline has not passed/)
    expect(await snapshot()).toEqual({ leaves: [leaf], box: boxBefore, raised: amount })
  })
})
