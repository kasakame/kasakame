import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import { accountInfo, advanceTime, assertRejectedUnchanged } from '@kasakame/utils/testing'
import { TransactionType, type TransactionWithSigner } from 'algosdk'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  clearTreeCache,
  createCampaign,
  deleteCampaign,
  fetchChainTimestamp,
  fetchMyLeaves,
  fetchVaultBox,
  pledgeGroup,
  refundGroup,
  refundOpUpIterations,
  vaultAddress,
  waitForIndexerCatchUp,
} from '../src/index.js'
import { headerOf, leafAt, session, setupSdkStack, type SdkStack } from './utils/index.js'

describe('SDK group builders (localnet)', () => {
  const fixture = algorandFixture()
  let stack: SdkStack

  beforeAll(async () => {
    stack = await setupSdkStack(fixture)
  })

  test('SDK-080 submit pledgeGroup and both refundGroup routes', { tags: ['happy', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK group builders', 'ipfs://sdk-group-builders', 10n * MICRO_ALGOS_PER_ALGO, deadline)
    const firstAmount = 2n * MICRO_ALGOS_PER_ALGO
    const secondAmount = MICRO_ALGOS_PER_ALGO

    const submit = async (group: TransactionWithSigner[]): Promise<void> => {
      const composer = stack.algorand.send.newGroup()
      for (const transaction of group) composer.addTransaction(transaction.txn, transaction.signer)
      await composer.send()
      clearTreeCache()
      await waitForIndexerCatchUp()
    }

    const pledgeGroup1 = await pledgeGroup(appId, backer, firstAmount)
    expect(pledgeGroup1).toHaveLength(3)
    const [payment, pledgeCall, creditCall] = pledgeGroup1
    if (payment === undefined || pledgeCall === undefined || creditCall === undefined) throw new Error('pledge group shape changed')
    expect(payment.txn.type).toEqual(TransactionType.pay)
    expect(payment.txn.sender.toString()).toEqual(backer.address)
    expect(payment.txn.payment?.receiver.toString()).toEqual(vaultAddress())
    expect(payment.txn.payment?.amount).toEqual(firstAmount)
    expect(pledgeCall.txn.type).toEqual(TransactionType.appl)
    expect(pledgeCall.txn.sender.toString()).toEqual(backer.address)
    expect(pledgeCall.txn.applicationCall?.appIndex).toEqual(appId)
    expect(creditCall.txn.type).toEqual(TransactionType.appl)
    expect(creditCall.txn.applicationCall?.appIndex).toEqual(stack.vaultAppId)
    expect([payment.signer, pledgeCall.signer, creditCall.signer]).toEqual([backer.signer, backer.signer, backer.signer])
    await submit(pledgeGroup1)

    expect((await fetchMyLeaves(appId, backer.address)).map(({ position, amount }) => ({ position, amount }))).toEqual([
      { position: 0, amount: firstAmount },
    ])
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(firstAmount)
    expect((await fetchVaultBox(appId))?.paidIn).toEqual(firstAmount)

    // A group with the credit transaction removed must fail without adding a leaf or touching the box.
    const malformed = await pledgeGroup(appId, backer, secondAmount)
    const malformedComposer = stack.algorand.send.newGroup()
    for (const transaction of malformed.slice(0, 2)) malformedComposer.addTransaction(transaction.txn, transaction.signer)
    // A fee-funded non-credit third transaction reaches the contract's group-shape guard.
    const filler = await stack.algorand.createTransaction.payment({
      sender: backer.address,
      receiver: backer.address,
      amount: microAlgos(0n),
      staticFee: microAlgos(10n * stack.minFee),
    })
    malformedComposer.addTransaction(filler, backer.signer)
    await assertRejectedUnchanged(
      () => malformedComposer.send(),
      async () => {
        clearTreeCache()
        return {
          leaves: await fetchMyLeaves(appId, backer.address),
          box: await fetchVaultBox(appId),
        }
      },
      /credit must follow pledge/,
    )

    await submit(await pledgeGroup(appId, backer, secondAmount))
    expect((await fetchMyLeaves(appId, backer.address)).map(({ position, amount }) => ({ position, amount }))).toEqual([
      { position: 0, amount: firstAmount },
      { position: 1, amount: secondAmount },
    ])
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(firstAmount + secondAmount)
    expect((await fetchVaultBox(appId))?.paidIn).toEqual(firstAmount + secondAmount)

    await advanceTime(fixture, 90_001)

    // Open box: the campaign path pays through its inner vault calls.
    const firstLeaf = leafAt(await fetchMyLeaves(appId, backer.address), 0)
    const campaignRefund = await refundGroup(appId, backer, firstLeaf)
    expect(campaignRefund).toHaveLength(1)
    const [campaignCall] = campaignRefund
    if (campaignCall === undefined) throw new Error('campaign refund group shape changed')
    expect(campaignCall.txn.type).toEqual(TransactionType.appl)
    expect(campaignCall.txn.sender.toString()).toEqual(backer.address)
    expect(campaignCall.txn.applicationCall?.appIndex).toEqual(appId)
    expect(campaignCall.signer).toBe(backer.signer)
    const campaignTakes = refundOpUpIterations(2n, 0n)
    const backerBeforeCampaignRefund = await accountInfo(stack.algorand, backer.address)
    await submit(campaignRefund)
    const backerAfterCampaignRefund = await accountInfo(stack.algorand, backer.address)
    expect(backerAfterCampaignRefund.balance - backerBeforeCampaignRefund.balance).toEqual(
      firstAmount - (3n + BigInt(campaignTakes)) * stack.minFee,
    )
    expect(backerAfterCampaignRefund.minBalance).toEqual(backerBeforeCampaignRefund.minBalance)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(secondAmount)
    expect((await fetchVaultBox(appId))?.paidOut).toEqual(firstAmount)

    await deleteCampaign(appId, creator)
    const settled = await fetchVaultBox(appId)
    expect(settled?.status).toEqual(2)
    expect(settled?.paidIn).toEqual(firstAmount + secondAmount)
    expect(settled?.paidOut).toEqual(firstAmount)

    // Failed box after delete: the vault path pays directly and applies the window.
    const secondLeaf = leafAt(await fetchMyLeaves(appId, backer.address), 1)
    const vaultRefund = await refundGroup(appId, backer, secondLeaf)
    expect(vaultRefund).toHaveLength(1)
    const [vaultCall] = vaultRefund
    if (vaultCall === undefined) throw new Error('vault refund group shape changed')
    expect(vaultCall.txn.type).toEqual(TransactionType.appl)
    expect(vaultCall.txn.sender.toString()).toEqual(backer.address)
    expect(vaultCall.txn.applicationCall?.appIndex).toEqual(stack.vaultAppId)
    expect(vaultCall.signer).toBe(backer.signer)
    const vaultTakes = refundOpUpIterations(2n, 1n)
    const backerBeforeVaultRefund = await accountInfo(stack.algorand, backer.address)
    await submit(vaultRefund)
    const backerAfterVaultRefund = await accountInfo(stack.algorand, backer.address)
    expect(backerAfterVaultRefund.balance - backerBeforeVaultRefund.balance).toEqual(
      secondAmount - (2n + BigInt(vaultTakes)) * stack.minFee,
    )
    expect(backerAfterVaultRefund.minBalance).toEqual(backerBeforeVaultRefund.minBalance)
    expect(await fetchMyLeaves(appId, backer.address)).toEqual([])
    expect((await fetchVaultBox(appId))?.paidOut).toEqual(firstAmount + secondAmount)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(0n)
  })
})
