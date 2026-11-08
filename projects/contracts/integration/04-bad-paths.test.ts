import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import type { Account } from 'algosdk'
import { ABIMethod, OnApplicationComplete } from 'algosdk'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  ALGO,
  ClaimTreeOracle,
  FEE,
  REGISTER_MBR,
  advanceTime,
  campaignBoxExists,
  concatHex,
  deployCampaign,
  deployStack,
  pledge,
  registrationBoxRef,
  spendExtraFee,
  vaultBoxRef,
  type ContractStack,
} from './support/localnet'

interface CampaignFixture {
  appClient: AppClient
  appId: bigint
  creator: Account
  oracle: ClaimTreeOracle
}

interface PaymentOptions {
  amount: bigint
  sender?: string
  receiver?: string
}

async function createCampaign(
  fixture: AlgorandFixture,
  stack: ContractStack,
  options: { goal?: bigint; register?: boolean } = {},
): Promise<CampaignFixture> {
  const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
  const campaign = await deployCampaign(stack, creator.addr.toString(), options)
  return { ...campaign, creator, oracle: new ClaimTreeOracle('bad-path-') }
}

async function buildPledgeGroup(
  stack: ContractStack,
  campaign: CampaignFixture,
  callerAddr: string,
  payment: PaymentOptions,
  frontier: string[],
  withCredit = true,
): Promise<ReturnType<ContractStack['algorand']['send']['newGroup']>> {
  const pay = await stack.algorand.createTransaction.payment({
    sender: payment.sender ?? callerAddr,
    receiver: payment.receiver ?? stack.vault.address,
    amount: microAlgos(payment.amount),
  })
  const composer = stack.algorand.send.newGroup()
  composer.addAppCallMethodCall({
    appId: campaign.appId,
    method: ABIMethod.fromSignature('pledge(pay,byte[])void'),
    args: [pay, concatHex(frontier)],
    sender: callerAddr,
  })
  if (withCredit) {
    composer.addAppCallMethodCall({
      appId: stack.vault.appId,
      method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
      args: [campaign.appId, payment.amount],
      sender: callerAddr,
      appReferences: [stack.factory.appId],
      boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId), registrationBoxRef(stack.factory.appId, campaign.appId)],
      extraFee: microAlgos(FEE),
    })
  }
  return composer
}

describe('04 bad paths', () => {
  const fixture = algorandFixture()
  let stack: ContractStack

  beforeAll(async () => {
    stack = await deployStack(fixture)
  })

  test('CON-100 creator cannot pledge to their own campaign', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const composer = await buildPledgeGroup(stack, campaign, campaign.creator.addr.toString(), { amount: 1n * ALGO }, [])
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/creator cannot pledge to their own campaign/)
  })

  test('CON-101 pledge payment must go to the vault', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const composer = await buildPledgeGroup(
      stack,
      campaign,
      backer.addr.toString(),
      { amount: 1n * ALGO, receiver: campaign.creator.addr.toString() },
      [],
    )
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/payment must be made to the vault/)
  })

  test('CON-102 pledge payment sender must be the caller', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const composer = await buildPledgeGroup(
      stack,
      campaign,
      backer.addr.toString(),
      { amount: 1n * ALGO, sender: campaign.creator.addr.toString() },
      [],
    )
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/payment must come from the caller/)
  })

  test('CON-103 zero pledge is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const composer = await buildPledgeGroup(stack, campaign, backer.addr.toString(), { amount: 0n }, [])
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/pledge must be greater than zero/)
  })

  test('CON-104 pledge below the minimum is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const composer = await buildPledgeGroup(stack, campaign, backer.addr.toString(), { amount: 1n }, [])
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/pledge below minimum/)
  })

  test('CON-105 stale frontier after a real pledge is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })

    await pledge(stack, campaign.appClient, campaign.appId, backerA.addr.toString(), 1n * ALGO, campaign.oracle)
    const staleFrontier = campaign.oracle
      .frontier()
      .peaks.map((peak) => (peak.slice(0, 2) === '00' ? `01${peak.slice(2)}` : `00${peak.slice(2)}`))
    const composer = await buildPledgeGroup(stack, campaign, backerB.addr.toString(), { amount: 1n * ALGO }, staleFrontier)
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/stale or forged frontier/)
  })

  test('CON-106 pledge without the matching credit is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const composer = await buildPledgeGroup(stack, campaign, backer.addr.toString(), { amount: 1n * ALGO }, [], false)
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/credit must follow pledge/)
    expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
  })

  test('CON-107 unregistered campaign cannot be credited', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack, { register: false })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const composer = await buildPledgeGroup(stack, campaign, backer.addr.toString(), { amount: 1n * ALGO }, [])
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/campaign not registered/)
    expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
  })

  test('CON-108 cancel after the deadline is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txid = await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * ALGO, campaign.oracle)
    const path = campaign.oracle.path(0)
    const blob = concatHex([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
    await advanceTime(fixture, 900)

    await expect(
      campaign.appClient.send.call({
        method: 'cancelPledge(uint64,uint64,byte[],byte[])void',
        args: [0n, 1n * ALGO, Buffer.from(txid, 'hex'), blob],
        sender: backer.addr,
        appReferences: [stack.vault.appId],
        boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
        extraFee: microAlgos(spendExtraFee(path, 2)),
        suppressLog: true,
      }),
    ).rejects.toThrow(/pledging is closed/)
  })

  test('CON-109 refund before the deadline is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txid = await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * ALGO, campaign.oracle)
    const path = campaign.oracle.path(0)
    const blob = concatHex([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])

    await expect(
      campaign.appClient.send.call({
        method: 'refund(uint64,uint64,byte[],byte[])void',
        args: [0n, 1n * ALGO, Buffer.from(txid, 'hex'), blob],
        sender: backer.addr,
        appReferences: [stack.vault.appId],
        boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
        extraFee: microAlgos(spendExtraFee(path, 2)),
        suppressLog: true,
      }),
    ).rejects.toThrow(/deadline has not passed/)
  })

  test('CON-110 refund after the goal was reached is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack, { goal: 1n * ALGO })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txid = await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 2n * ALGO, campaign.oracle)
    const path = campaign.oracle.path(0)
    const blob = concatHex([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
    await advanceTime(fixture, 900)

    await expect(
      campaign.appClient.send.call({
        method: 'refund(uint64,uint64,byte[],byte[])void',
        args: [0n, 2n * ALGO, Buffer.from(txid, 'hex'), blob],
        sender: backer.addr,
        appReferences: [stack.vault.appId],
        boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
        extraFee: microAlgos(spendExtraFee(path, 2)),
        suppressLog: true,
      }),
    ).rejects.toThrow(/goal was reached, no refunds/)
  })

  test('CON-111 only the creator can claim', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack, { goal: 1n * ALGO })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * ALGO, campaign.oracle)
    await advanceTime(fixture, 900)

    await expect(
      campaign.appClient.send.call({
        method: 'claim()void',
        args: [],
        sender: backer.addr,
        appReferences: [stack.vault.appId],
        boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
        extraFee: microAlgos(2n * FEE),
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the creator can claim/)
  })

  test('CON-112 raw delete is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * ALGO, campaign.oracle)

    const composer = stack.algorand.send.newGroup()
    composer.addAppCallMethodCall({
      appId: campaign.appId,
      method: ABIMethod.fromSignature('delete()void'),
      args: [],
      sender: campaign.creator.addr,
      onComplete: OnApplicationComplete.DeleteApplicationOC,
      appReferences: [stack.vault.appId],
      boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
      extraFee: microAlgos(2n * FEE),
    })
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/unregister must precede delete/)
  })

  test('CON-113 a live campaign cannot be unregistered', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * ALGO, campaign.oracle)

    const composer = stack.algorand.send.newGroup()
    composer.addAppCallMethodCall({
      appId: stack.factory.appId,
      method: ABIMethod.fromSignature('unregister(uint64)void'),
      args: [campaign.appId],
      sender: campaign.creator.addr,
      appReferences: [campaign.appId],
      extraFee: microAlgos(FEE),
    })
    composer.addAppCallMethodCall({
      appId: campaign.appId,
      method: ABIMethod.fromSignature('delete()void'),
      args: [],
      sender: campaign.creator.addr,
      onComplete: OnApplicationComplete.DeleteApplicationOC,
      appReferences: [stack.vault.appId],
      boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
      extraFee: microAlgos(2n * FEE),
    })
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/campaign is still live/)
  })

  test('CON-114 credit without a preceding pledge is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const pay = await stack.algorand.createTransaction.payment({
      sender: backer.addr,
      receiver: stack.vault.address,
      amount: microAlgos(1n * ALGO),
    })
    const composer = stack.algorand.send.newGroup()
    composer.addTransaction(pay)
    composer.addAppCallMethodCall({
      appId: stack.vault.appId,
      method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
      args: [campaign.appId, 1n * ALGO],
      sender: backer.addr,
      appReferences: [stack.factory.appId],
      boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId), registrationBoxRef(stack.factory.appId, campaign.appId)],
      extraFee: microAlgos(FEE),
    })
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/credit must follow pledge/)
  })

  test('CON-115 top-level vault inner methods are rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const stranger = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * ALGO, campaign.oracle)

    await expect(
      stack.vault.client.send.call({
        method: 'payBack(uint64,address,uint64)void',
        args: [campaign.appId, stranger.addr, 1n],
        sender: stranger.addr,
        appReferences: [campaign.appId],
        boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
        suppressLog: true,
      }),
    ).rejects.toThrow(/not the campaign app/)
    await expect(
      stack.vault.client.send.call({
        method: 'payClaim(uint64)void',
        args: [campaign.appId],
        sender: stranger.addr,
        appReferences: [campaign.appId],
        boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
        suppressLog: true,
      }),
    ).rejects.toThrow(/not the campaign app/)
  })

  test('CON-116 only the Factory owner can set the program hash', { tags: ['bad', 'always'] }, async () => {
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    await expect(
      stack.factory.client.send.call({
        method: 'setApprovalHash(byte[])void',
        args: [new Uint8Array(32)],
        sender: stranger.addr,
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the owner can set the program hash/)
  })

  test('CON-117 program hash must be 32 bytes', { tags: ['bad', 'always'] }, async () => {
    await expect(
      stack.factory.client.send.call({
        method: 'setApprovalHash(byte[])void',
        args: [new Uint8Array(31)],
        sender: stack.owner.addr,
        suppressLog: true,
      }),
    ).rejects.toThrow(/program hash must be 32 bytes/)
  })

  test('CON-118 an impostor campaign cannot register', { tags: ['bad', 'always'] }, async () => {
    const payment = await stack.algorand.createTransaction.payment({
      sender: stack.owner.addr,
      receiver: stack.factory.address,
      amount: microAlgos(REGISTER_MBR),
    })
    await expect(
      stack.factory.client.send.call({
        method: 'register(uint64,pay)void',
        args: [stack.factory.appId, payment],
        sender: stack.owner.addr,
        appReferences: [stack.factory.appId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/not an official kasakame campaign/)
  })
})
