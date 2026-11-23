import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO, REGISTER_DEPOSIT_MICRO_ALGOS, VAULT_BOX_MBR_MICRO_ALGOS } from '@kasakame/constants'
import { accountInfo } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  cancelPledge,
  createCampaign,
  deleteCampaign,
  fetchChainTimestamp,
  fetchMyLeaves,
  fetchVaultBox,
  finalize,
  isRegistered,
  pledge,
  refundOpUpIterations,
} from '../src/index.js'
import { headerOf, leafAt, session, setupSdkStack, type SdkStack } from './utils/index.js'

describe('SDK open campaign (localnet)', () => {
  const fixture = algorandFixture()
  let stack: SdkStack

  beforeAll(async () => {
    stack = await setupSdkStack(fixture)
  })

  test('SDK-001 create → pledge → cancel → later pledge → cancel → delete → finalize', { tags: ['smoke', 'happy', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n

    const creatorBefore = await accountInfo(stack.algorand, creator.address)
    const registryBefore = await accountInfo(stack.algorand, stack.registryAddress)
    const vaultBefore = await accountInfo(stack.algorand, stack.vaultAddress)
    const { appId } = await createCampaign(creator, 'SDK open campaign', 'ipfs://sdk-open', 10n * MICRO_ALGOS_PER_ALGO, deadline)
    expect(await isRegistered(appId)).toBe(true)

    // Create is one txn and register is register + deposit (2 outer), so 3 min fees.
    const creatorAfterCreate = await accountInfo(stack.algorand, creator.address)
    const campaignMbr = creatorAfterCreate.minBalance - creatorBefore.minBalance
    expect(campaignMbr).toBeGreaterThan(0n)
    expect(creatorBefore.balance - creatorAfterCreate.balance - REGISTER_DEPOSIT_MICRO_ALGOS).toEqual(3n * stack.minFee)
    const registryAfterCreate = await accountInfo(stack.algorand, stack.registryAddress)
    expect(registryAfterCreate.minBalance - registryBefore.minBalance).toEqual(REGISTER_DEPOSIT_MICRO_ALGOS)
    expect(registryAfterCreate.balance - registryBefore.balance).toEqual(REGISTER_DEPOSIT_MICRO_ALGOS)

    // First pledge: pay + pledge + credit (3 outer) + the first-touch Registry check (1 inner).
    const firstAmount = 2n * MICRO_ALGOS_PER_ALGO
    const backerBeforePledge = await accountInfo(stack.algorand, backer.address)
    await pledge(appId, backer, firstAmount)
    const backerAfterPledge = await accountInfo(stack.algorand, backer.address)
    expect(backerBeforePledge.balance - backerAfterPledge.balance - firstAmount).toEqual(4n * stack.minFee)
    expect(backerAfterPledge.minBalance).toEqual(backerBeforePledge.minBalance)
    const vaultAfterPledge = await accountInfo(stack.algorand, stack.vaultAddress)
    expect(vaultAfterPledge.minBalance - vaultBefore.minBalance).toEqual(VAULT_BOX_MBR_MICRO_ALGOS)
    expect(vaultAfterPledge.balance - vaultBefore.balance).toEqual(firstAmount)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(firstAmount)

    // Cancel: campaign outer + 2 payout inners + the OpUp takes for this shape.
    const firstLeaf = leafAt(await fetchMyLeaves(appId, backer.address), 0)
    const firstCancelTakes = refundOpUpIterations(1n, 0n)
    const backerBeforeCancel = await accountInfo(stack.algorand, backer.address)
    await cancelPledge(appId, backer, firstLeaf)
    const backerAfterCancel = await accountInfo(stack.algorand, backer.address)
    expect(backerAfterCancel.balance - backerBeforeCancel.balance).toEqual(firstAmount - (3n + BigInt(firstCancelTakes)) * stack.minFee)
    expect(backerAfterCancel.minBalance).toEqual(backerBeforePledge.minBalance)
    expect(await fetchMyLeaves(appId, backer.address)).toEqual([])
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(0n)

    // Later pledge: no first-touch Registry check, so the on-chain minimum is 3 txns; the SDK still funds 4 (documented headroom).
    const laterAmount = MICRO_ALGOS_PER_ALGO
    const backerBeforeLater = await accountInfo(stack.algorand, backer.address)
    await pledge(appId, backer, laterAmount)
    const backerAfterLater = await accountInfo(stack.algorand, backer.address)
    const laterFee = backerBeforeLater.balance - backerAfterLater.balance - laterAmount
    expect(laterFee).toEqual(4n * stack.minFee)
    expect(laterFee - 3n * stack.minFee).toEqual(stack.minFee)
    const vaultAfterLater = await accountInfo(stack.algorand, stack.vaultAddress)
    expect(vaultAfterLater.minBalance - vaultBefore.minBalance).toEqual(VAULT_BOX_MBR_MICRO_ALGOS)

    const laterLeaf = leafAt(await fetchMyLeaves(appId, backer.address), 1)
    const laterCancelTakes = refundOpUpIterations(2n, 1n)
    const backerBeforeLaterCancel = await accountInfo(stack.algorand, backer.address)
    await cancelPledge(appId, backer, laterLeaf)
    const backerAfterLaterCancel = await accountInfo(stack.algorand, backer.address)
    expect(backerAfterLaterCancel.balance - backerBeforeLaterCancel.balance).toEqual(
      laterAmount - (3n + BigInt(laterCancelTakes)) * stack.minFee,
    )
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(0n)

    // Delete: unregister + inner deposit (2) + delete + 2 inners (3) = 5 min fees; the deposit returns.
    const creatorBeforeDelete = await accountInfo(stack.algorand, creator.address)
    await deleteCampaign(appId, creator)
    const creatorAfterDelete = await accountInfo(stack.algorand, creator.address)
    expect(creatorBeforeDelete.minBalance - creatorAfterDelete.minBalance).toEqual(campaignMbr)
    expect(creatorAfterDelete.balance - creatorBeforeDelete.balance).toEqual(REGISTER_DEPOSIT_MICRO_ALGOS - 5n * stack.minFee)
    const registryAfterDelete = await accountInfo(stack.algorand, stack.registryAddress)
    expect(registryAfterDelete).toEqual(registryBefore)
    expect(await isRegistered(appId)).toBe(false)
    await expect(stack.algorand.app.getById(appId)).rejects.toThrow()

    // Finalize a fully paid-out failed box: vault outer only, releases the box MBR.
    const creatorBeforeFinalize = await accountInfo(stack.algorand, creator.address)
    const vaultBeforeFinalize = await accountInfo(stack.algorand, stack.vaultAddress)
    await finalize(appId, creator)
    const creatorAfterFinalize = await accountInfo(stack.algorand, creator.address)
    const vaultAfterFinalize = await accountInfo(stack.algorand, stack.vaultAddress)
    expect(creatorBeforeFinalize.balance - creatorAfterFinalize.balance).toEqual(stack.minFee)
    expect(vaultBeforeFinalize.minBalance - vaultAfterFinalize.minBalance).toEqual(VAULT_BOX_MBR_MICRO_ALGOS)
    expect(await fetchVaultBox(appId)).toBeUndefined()
  })
})
