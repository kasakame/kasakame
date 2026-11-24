import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import { accountInfo, assertRejectedUnchanged } from '@kasakame/utils/testing'
import { TransactionType } from 'algosdk'
import { beforeAll, describe, expect, test } from 'vitest'
import { deleteCampaign, fetchMyLeaves, fetchVaultBox, pledgeGroup, refundGroup, vaultAddress } from '../src/index.js'
import {
  advancePastDeadline,
  campaignSnapshot,
  campaignSpendFee,
  createTestCampaign,
  expectLeaves,
  expectVaultBox,
  headerOf,
  leafAt,
  session,
  setupSdkStack,
  submitGroup,
  vaultSpendFee,
  type SdkStack,
} from './utils/index.js'

describe('SDK group builders (localnet)', () => {
  const fixture = algorandFixture()
  let stack: SdkStack

  beforeAll(async () => {
    stack = await setupSdkStack(fixture)
  })

  test('SDK-080 submit pledgeGroup and both refundGroup routes', { tags: ['happy', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 50n)
    const { appId } = await createTestCampaign(creator, 10n * MICRO_ALGOS_PER_ALGO)
    const firstAmount = 2n * MICRO_ALGOS_PER_ALGO
    const secondAmount = MICRO_ALGOS_PER_ALGO

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
    await submitGroup(stack.algorand, pledgeGroup1)

    expectLeaves(await fetchMyLeaves(appId, backer.address), [{ position: 0, amount: firstAmount }])
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(firstAmount)
    expectVaultBox(await fetchVaultBox(appId), { paidIn: firstAmount })

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
      () => campaignSnapshot(appId, backer.address),
      /credit must follow pledge/,
    )

    await submitGroup(stack.algorand, await pledgeGroup(appId, backer, secondAmount))
    expectLeaves(await fetchMyLeaves(appId, backer.address), [
      { position: 0, amount: firstAmount },
      { position: 1, amount: secondAmount },
    ])
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(firstAmount + secondAmount)
    expectVaultBox(await fetchVaultBox(appId), { paidIn: firstAmount + secondAmount })

    await advancePastDeadline(fixture)

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
    const campaignFee = campaignSpendFee(stack.minFee, 2n, 0n)
    const backerBeforeCampaignRefund = await accountInfo(stack.algorand, backer.address)
    await submitGroup(stack.algorand, campaignRefund)
    const backerAfterCampaignRefund = await accountInfo(stack.algorand, backer.address)
    expect(backerAfterCampaignRefund.balance - backerBeforeCampaignRefund.balance).toEqual(firstAmount - campaignFee)
    expect(backerAfterCampaignRefund.minBalance).toEqual(backerBeforeCampaignRefund.minBalance)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(secondAmount)
    expectVaultBox(await fetchVaultBox(appId), { paidOut: firstAmount })

    await deleteCampaign(appId, creator)
    expectVaultBox(await fetchVaultBox(appId), { status: 2, paidIn: firstAmount + secondAmount, paidOut: firstAmount })

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
    const vaultFee = vaultSpendFee(stack.minFee, 2n, 1n)
    const backerBeforeVaultRefund = await accountInfo(stack.algorand, backer.address)
    await submitGroup(stack.algorand, vaultRefund)
    const backerAfterVaultRefund = await accountInfo(stack.algorand, backer.address)
    expect(backerAfterVaultRefund.balance - backerBeforeVaultRefund.balance).toEqual(secondAmount - vaultFee)
    expect(backerAfterVaultRefund.minBalance).toEqual(backerBeforeVaultRefund.minBalance)
    expectLeaves(await fetchMyLeaves(appId, backer.address), [])
    expectVaultBox(await fetchVaultBox(appId), { paidOut: firstAmount + secondAmount })
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(0n)
  })
})
