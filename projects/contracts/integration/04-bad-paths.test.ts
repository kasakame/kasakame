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
  accountInfo,
  advanceTime,
  appIdBytes,
  balanceOf,
  campaignBox,
  campaignBoxExists,
  campaignState,
  claimCampaign,
  concatHex,
  deleteCampaign,
  deployCampaign,
  deployStack,
  isRegistered,
  pledge,
  registrationBoxRef,
  spendCampaign,
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
  closeRemainderTo?: string
  rekeyTo?: string
  /** Account that pays the whole group's fees (for the close-remainder case, where the payer is drained). */
  feePayer?: string
}

interface CreditOptions {
  /** Whether to add the credit at all. Defaults to true. */
  with?: boolean
  /** Target app override. */
  appId?: bigint
  /** Credit amount override. */
  amount?: bigint
  /** Raw selector override (used for the wrong-selector case). */
  rawSelector?: Uint8Array
  /** OnCompletion override (used for the ClearState case). */
  onComplete?: Exclude<OnApplicationComplete, OnApplicationComplete.UpdateApplicationOC>
  /** Number of credit calls to append (one payment, two credits). Defaults to one. */
  count?: number
  /** Add a transaction after the credit so it is not the final transaction. */
  trailingTxn?: boolean
}

async function createCampaign(
  fixture: AlgorandFixture,
  stack: ContractStack,
  options: { goal?: bigint; register?: boolean; vaultId?: bigint } = {},
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
  credit: CreditOptions | boolean = {},
): Promise<ReturnType<ContractStack['algorand']['send']['newGroup']>> {
  const options: CreditOptions = typeof credit === 'boolean' ? { with: credit } : credit
  const count = options.count ?? 1
  const composer = stack.algorand.send.newGroup()
  const defaultFee = payment.feePayer === undefined
  const feePayer = payment.feePayer
  if (feePayer !== undefined) {
    const groupSize = 3n + BigInt(count) + (options.trailingTxn === true ? 1n : 0n)
    composer.addPayment({
      sender: feePayer,
      receiver: feePayer,
      amount: microAlgos(0n),
      staticFee: microAlgos(groupSize * FEE),
    })
  }
  const pay = await stack.algorand.createTransaction.payment({
    sender: payment.sender ?? callerAddr,
    receiver: payment.receiver ?? stack.vault.address,
    amount: microAlgos(payment.amount),
    ...(payment.closeRemainderTo === undefined ? {} : { closeRemainderTo: payment.closeRemainderTo }),
    ...(payment.rekeyTo === undefined ? {} : { rekeyTo: payment.rekeyTo }),
    ...(defaultFee ? {} : { staticFee: microAlgos(0n) }),
  })
  composer.addAppCallMethodCall({
    appId: campaign.appId,
    method: ABIMethod.fromSignature('pledge(pay,byte[])void'),
    args: [pay, concatHex(frontier)],
    sender: callerAddr,
    ...(defaultFee ? {} : { staticFee: microAlgos(0n) }),
  })
  if (options.with !== false) {
    for (let i = 0; i < count; i++) {
      const target = options.appId ?? stack.vault.appId
      const creditParams = {
        appId: target,
        sender: callerAddr,
        appReferences: target === stack.vault.appId ? [stack.factory.appId] : [stack.factory.appId, stack.vault.appId],
        boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId), registrationBoxRef(stack.factory.appId, campaign.appId)],
        ...(defaultFee ? { extraFee: microAlgos(FEE) } : { staticFee: microAlgos(0n) }),
      }
      if (options.rawSelector !== undefined) {
        composer.addAppCall({
          ...creditParams,
          ...(options.onComplete === undefined ? {} : { onComplete: options.onComplete }),
          args: [options.rawSelector, appIdBytes(campaign.appId), appIdBytes(options.amount ?? payment.amount)],
        })
      } else {
        composer.addAppCallMethodCall({
          ...creditParams,
          method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
          args: [campaign.appId, options.amount ?? payment.amount],
        })
      }
    }
    if (options.trailingTxn === true) {
      composer.addPayment({
        sender: callerAddr,
        receiver: callerAddr,
        amount: microAlgos(0n),
        ...(defaultFee ? {} : { staticFee: microAlgos(0n) }),
      })
    }
  }
  return composer
}

async function failedCampaign(
  fixture: AlgorandFixture,
  stack: ContractStack,
  amount = 1n * ALGO,
  goal = 2n * ALGO,
): Promise<{ campaign: CampaignFixture; backer: Account; txid: string }> {
  const campaign = await createCampaign(fixture, stack, { goal })
  const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
  const txid = await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), amount, campaign.oracle)
  await advanceTime(fixture, 900)
  return { campaign, backer, txid }
}

async function refundFromVault(
  stack: ContractStack,
  campaign: CampaignFixture,
  backer: Account,
  k: number,
  amount: bigint,
  txid: string,
  path: { siblings: string[]; top: string | null; lower: string[] },
): Promise<void> {
  const blob = concatHex([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
  await stack.vault.client.send.call({
    method: 'refund(uint64,uint64,uint64,byte[],byte[])void',
    args: [campaign.appId, BigInt(k), amount, Buffer.from(txid, 'hex'), blob],
    sender: backer.addr,
    boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
    extraFee: microAlgos(FEE + 2n * FEE),
    suppressLog: true,
  })
}

async function settleOpen(stack: ContractStack, appId: bigint, sender: string): Promise<void> {
  await stack.vault.client.send.call({
    method: 'settleOpen(uint64)void',
    args: [appId],
    sender,
    appReferences: [appId],
    suppressLog: true,
  })
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

    const pristine = await createCampaign(fixture, stack)
    const stranger = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const strangerGroup = stack.algorand.send.newGroup()
    strangerGroup.addAppCallMethodCall({
      appId: stack.factory.appId,
      method: ABIMethod.fromSignature('unregister(uint64)void'),
      args: [pristine.appId],
      sender: stranger.addr,
      appReferences: [pristine.appId],
      extraFee: microAlgos(FEE),
    })
    strangerGroup.addAppCallMethodCall({
      appId: pristine.appId,
      method: ABIMethod.fromSignature('delete()void'),
      args: [],
      sender: pristine.creator.addr,
      onComplete: OnApplicationComplete.DeleteApplicationOC,
      appReferences: [stack.vault.appId],
      extraFee: microAlgos(2n * FEE),
    })
    await expect(strangerGroup.send({ suppressLog: true })).rejects.toThrow(/only the campaign creator can unregister/)
    expect(await isRegistered(stack.factory.client, pristine.appId, stack.ownerAddress)).toEqual(true)
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
    await expect(
      stack.vault.client.send.call({
        method: 'settle(uint64,byte[],uint64)void',
        args: [campaign.appId, new Uint8Array(32), 1n],
        sender: stranger.addr,
        appReferences: [campaign.appId],
        boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
        suppressLog: true,
      }),
    ).rejects.toThrow(/not the campaign app/)
    await expect(
      stack.vault.client.send.call({
        method: 'notifyDelete(uint64)void',
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

  test(
    'CON-119 vault refund rejects an open box, a claimed box, a closed window, and an unknown position',
    { tags: ['bad', 'always'] },
    async () => {
      const open = await failedCampaign(fixture, stack)
      const openState = await campaignState(open.campaign.appClient)
      const openBox = await campaignBox(stack.vault.client, open.campaign.appId)
      await expect(
        refundFromVault(stack, open.campaign, open.backer, 0, 1n * ALGO, open.txid, open.campaign.oracle.path(0)),
      ).rejects.toThrow(/campaign is not refundable/)
      expect(await campaignState(open.campaign.appClient)).toEqual(openState)
      expect(await campaignBox(stack.vault.client, open.campaign.appId)).toEqual(openBox)

      const claimedCreator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      const claimedBacker = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      const claimed = await deployCampaign(stack, claimedCreator.addr.toString(), { goal: 1n * ALGO })
      const claimedOracle = new ClaimTreeOracle('claimed-guard-')
      const claimedTxid = await pledge(stack, claimed.appClient, claimed.appId, claimedBacker.addr.toString(), 1n * ALGO, claimedOracle)
      await advanceTime(fixture, 900)
      await claimCampaign(stack, claimed.appClient, claimed.appId, claimedCreator.addr.toString())
      await expect(
        refundFromVault(
          stack,
          { ...claimed, creator: claimedCreator, oracle: claimedOracle },
          claimedBacker,
          0,
          1n * ALGO,
          claimedTxid,
          claimedOracle.path(0),
        ),
      ).rejects.toThrow(/campaign is not refundable/)

      const window = await failedCampaign(fixture, stack)
      await deleteCampaign(stack, window.campaign.appId, window.campaign.creator.addr.toString())
      const windowBox = await campaignBox(stack.vault.client, window.campaign.appId)
      await advanceTime(fixture, 4_000)
      await expect(
        refundFromVault(stack, window.campaign, window.backer, 0, 1n * ALGO, window.txid, window.campaign.oracle.path(0)),
      ).rejects.toThrow(/refund window closed/)
      expect(await campaignBox(stack.vault.client, window.campaign.appId)).toEqual(windowBox)

      const unknown = await failedCampaign(fixture, stack)
      await deleteCampaign(stack, unknown.campaign.appId, unknown.campaign.creator.addr.toString())
      const unknownBox = await campaignBox(stack.vault.client, unknown.campaign.appId)
      await expect(
        stack.vault.client.send.call({
          method: 'refund(uint64,uint64,uint64,byte[],byte[])void',
          args: [unknown.campaign.appId, 1n, 1n * ALGO, Buffer.from(unknown.txid, 'hex'), new Uint8Array()],
          sender: unknown.backer.addr,
          boxReferences: [vaultBoxRef(stack.vault.appId, unknown.campaign.appId)],
          extraFee: microAlgos(FEE),
          suppressLog: true,
        }),
      ).rejects.toThrow(/unknown position/)
      expect(await campaignBox(stack.vault.client, unknown.campaign.appId)).toEqual(unknownBox)
    },
  )

  test(
    'CON-120 settleOpen rejects before the deadline, after the goal, on a claimed box, and on a failed box',
    { tags: ['bad', 'always'] },
    async () => {
      const early = await createCampaign(fixture, stack)
      const earlyBacker = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      await pledge(stack, early.appClient, early.appId, earlyBacker.addr.toString(), 1n * ALGO, early.oracle)
      const earlyState = await campaignState(early.appClient)
      await expect(settleOpen(stack, early.appId, earlyBacker.addr.toString())).rejects.toThrow(/deadline has not passed/)
      expect(await campaignState(early.appClient)).toEqual(earlyState)

      const goal = await createCampaign(fixture, stack, { goal: 1n * ALGO })
      const goalBacker = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      await pledge(stack, goal.appClient, goal.appId, goalBacker.addr.toString(), 1n * ALGO, goal.oracle)
      await advanceTime(fixture, 900)
      await expect(settleOpen(stack, goal.appId, goalBacker.addr.toString())).rejects.toThrow(/goal was reached/)

      const claimedCreator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      const claimedBacker = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      const claimed = await deployCampaign(stack, claimedCreator.addr.toString(), { goal: 1n * ALGO })
      const claimedOracle = new ClaimTreeOracle('settle-claimed-')
      await pledge(stack, claimed.appClient, claimed.appId, claimedBacker.addr.toString(), 1n * ALGO, claimedOracle)
      await advanceTime(fixture, 900)
      await claimCampaign(stack, claimed.appClient, claimed.appId, claimedCreator.addr.toString())
      await expect(settleOpen(stack, claimed.appId, claimedBacker.addr.toString())).rejects.toThrow(/campaign is not open/)

      const failed = await failedCampaign(fixture, stack)
      await deleteCampaign(stack, failed.campaign.appId, failed.campaign.creator.addr.toString())
      await expect(settleOpen(stack, failed.campaign.appId, failed.backer.addr.toString())).rejects.toThrow(/campaign is not open/)
    },
  )

  test('CON-121 releaseClaimed rejects a non-claimed box', { tags: ['bad', 'always'] }, async () => {
    const failed = await failedCampaign(fixture, stack)
    await deleteCampaign(stack, failed.campaign.appId, failed.campaign.creator.addr.toString())
    const box = await campaignBox(stack.vault.client, failed.campaign.appId)
    await expect(
      stack.vault.client.send.call({
        method: 'releaseClaimed(uint64)void',
        args: [failed.campaign.appId],
        sender: failed.backer.addr,
        boxReferences: [vaultBoxRef(stack.vault.appId, failed.campaign.appId)],
        suppressLog: true,
      }),
    ).rejects.toThrow(/campaign not claimed/)
    expect(await campaignBox(stack.vault.client, failed.campaign.appId)).toEqual(box)
  })

  test('CON-122 pledge payment cannot close or rekey', { tags: ['bad', 'always'] }, async () => {
    const close = await createCampaign(fixture, stack)
    const closeBacker = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const closeFrontier = close.oracle.frontier().peaks
    const closeBefore = await balanceOf(stack.algorand, closeBacker.addr.toString())
    await expect(
      buildPledgeGroup(
        stack,
        close,
        closeBacker.addr.toString(),
        { amount: 1n * ALGO, closeRemainderTo: close.creator.addr.toString(), feePayer: stack.ownerAddress },
        closeFrontier,
      ).then((c) => c.send({ suppressLog: true })),
    ).rejects.toThrow(/payment must not close/)
    expect(await balanceOf(stack.algorand, closeBacker.addr.toString())).toEqual(closeBefore)
    expect(await campaignBoxExists(stack.vault.client, close.appId)).toEqual(false)

    const rekey = await createCampaign(fixture, stack)
    const rekeyBacker = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const rekeyFrontier = rekey.oracle.frontier().peaks
    const rekeyBefore = await balanceOf(stack.algorand, rekeyBacker.addr.toString())
    await expect(
      buildPledgeGroup(
        stack,
        rekey,
        rekeyBacker.addr.toString(),
        { amount: 1n * ALGO, rekeyTo: rekey.creator.addr.toString() },
        rekeyFrontier,
      ).then((c) => c.send({ suppressLog: true })),
    ).rejects.toThrow(/payment must not rekey/)
    expect(await balanceOf(stack.algorand, rekeyBacker.addr.toString())).toEqual(rekeyBefore)
    expect(await campaignBoxExists(stack.vault.client, rekey.appId)).toEqual(false)
  })

  test(
    'CON-123 credit guards reject ClearState, wrong amount/app/selector, non-final, and repeated credits',
    { tags: ['bad', 'always'] },
    async () => {
      const cases: { credit: CreditOptions; message: RegExp }[] = [
        {
          credit: { rawSelector: new Uint8Array(4), onComplete: OnApplicationComplete.ClearStateOC },
          message: /credit must be a NoOp call/,
        },
        { credit: { amount: 2n * ALGO }, message: /credit amount mismatch/ },
        { credit: { appId: stack.factory.appId }, message: /credit must call the vault/ },
        { credit: { rawSelector: new Uint8Array(4) }, message: /credit selector mismatch/ },
        { credit: { trailingTxn: true }, message: /final transaction in the group/ },
        { credit: { count: 2 }, message: /final transaction in the group/ },
      ]
      for (const { credit, message } of cases) {
        const campaign = await createCampaign(fixture, stack)
        const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
        const frontier = campaign.oracle.frontier().peaks
        const before = await balanceOf(stack.algorand, backer.addr.toString())
        await expect(
          buildPledgeGroup(stack, campaign, backer.addr.toString(), { amount: 1n * ALGO }, frontier, credit).then((c) =>
            c.send({ suppressLog: true }),
          ),
        ).rejects.toThrow(message)
        expect(await balanceOf(stack.algorand, backer.addr.toString())).toEqual(before)
        expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
      }
    },
  )

  test('CON-124 a deleted campaign cannot be pledged or credited', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    await deleteCampaign(stack, campaign.appId, campaign.creator.addr.toString())
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const frontier = campaign.oracle.frontier().peaks
    await expect(
      buildPledgeGroup(stack, campaign, backer.addr.toString(), { amount: 1n * ALGO }, frontier).then((c) => c.send({ suppressLog: true })),
    ).rejects.toThrow()
    expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
  })

  test('CON-125 double spends and stale proofs are rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack)
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txidA = await pledge(stack, campaign.appClient, campaign.appId, backerA.addr.toString(), 1n * ALGO, campaign.oracle)
    const txidB = await pledge(stack, campaign.appClient, campaign.appId, backerB.addr.toString(), 1n * ALGO, campaign.oracle)
    const oldPathA = campaign.oracle.path(0)
    const oldPathB = campaign.oracle.path(1)

    await spendCampaign(
      stack,
      campaign.appClient,
      campaign.appId,
      backerA.addr.toString(),
      0,
      1n * ALGO,
      txidA,
      'cancelPledge(uint64,uint64,byte[],byte[])void',
      campaign.oracle,
    )
    const state = await campaignState(campaign.appClient)
    const box = await campaignBox(stack.vault.client, campaign.appId)

    const use = async (backer: Account, k: number, txid: string, path: typeof oldPathA): Promise<void> => {
      const blob = concatHex([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
      await campaign.appClient.send.call({
        method: 'cancelPledge(uint64,uint64,byte[],byte[])void',
        args: [BigInt(k), 1n * ALGO, Buffer.from(txid, 'hex'), blob],
        sender: backer.addr,
        appReferences: [stack.vault.appId],
        boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
        extraFee: microAlgos(spendExtraFee(path, 2)),
        suppressLog: true,
      })
    }

    await expect(use(backerA, 0, txidA, oldPathA)).rejects.toThrow(/proof does not match root/)
    await expect(use(backerB, 1, txidB, oldPathB)).rejects.toThrow(/proof does not match root/)
    expect(await campaignState(campaign.appClient)).toEqual(state)
    expect(await campaignBox(stack.vault.client, campaign.appId)).toEqual(box)

    const current = campaign.oracle.path(1)
    const currentBlob = concatHex([...current.siblings, ...(current.top === null ? [] : [current.top]), ...current.lower])
    const doubleGroup = stack.algorand.send.newGroup()
    for (let i = 0; i < 2; i++) {
      doubleGroup.addAppCallMethodCall({
        appId: campaign.appId,
        method: ABIMethod.fromSignature('cancelPledge(uint64,uint64,byte[],byte[])void'),
        args: [1n, 1n * ALGO, Buffer.from(txidB, 'hex'), currentBlob],
        sender: backerB.addr,
        note: new TextEncoder().encode(`double-spend-${i.toString()}`),
        appReferences: [stack.vault.appId],
        boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
        extraFee: microAlgos(spendExtraFee(current, 2)),
      })
    }
    await expect(doubleGroup.send({ suppressLog: true })).rejects.toThrow(/proof does not match root/)
    expect(await campaignState(campaign.appClient)).toEqual(state)
    expect(await campaignBox(stack.vault.client, campaign.appId)).toEqual(box)

    const fresh = campaign.oracle.path(1)
    const flip = (hex: string): string => `${hex.startsWith('00') ? '01' : '00'}${hex.slice(2)}`
    const first = fresh.siblings[0] ?? fresh.top ?? fresh.lower[0] ?? ''
    const forged =
      fresh.siblings.length > 0
        ? { ...fresh, siblings: [flip(first), ...fresh.siblings.slice(1)] }
        : fresh.top !== null
          ? { ...fresh, top: flip(first) }
          : { ...fresh, lower: [flip(first), ...fresh.lower.slice(1)] }
    await expect(use(backerB, 1, txidB, forged)).rejects.toThrow(/proof does not match root/)
    await spendCampaign(
      stack,
      campaign.appClient,
      campaign.appId,
      backerB.addr.toString(),
      1,
      1n * ALGO,
      txidB,
      'cancelPledge(uint64,uint64,byte[],byte[])void',
      campaign.oracle,
    )
  })

  test(
    'CON-126 Factory register rejects non-creators, different vaults, and double registration',
    { tags: ['bad', 'always'] },
    async () => {
      const nonCreatorCampaign = await createCampaign(fixture, stack, { register: false })
      const stranger = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      const strangerPay = await stack.algorand.createTransaction.payment({
        sender: stranger.addr,
        receiver: stack.factory.address,
        amount: microAlgos(REGISTER_MBR),
      })
      await expect(
        stack.factory.client.send.call({
          method: 'register(uint64,pay)void',
          args: [nonCreatorCampaign.appId, strangerPay],
          sender: stranger.addr,
          appReferences: [nonCreatorCampaign.appId],
          suppressLog: true,
        }),
      ).rejects.toThrow(/only the campaign creator can register/)

      const differentVault = await createCampaign(fixture, stack, { register: false, vaultId: stack.factory.appId })
      const differentPay = await stack.algorand.createTransaction.payment({
        sender: differentVault.creator.addr,
        receiver: stack.factory.address,
        amount: microAlgos(REGISTER_MBR),
      })
      await expect(
        stack.factory.client.send.call({
          method: 'register(uint64,pay)void',
          args: [differentVault.appId, differentPay],
          sender: differentVault.creator.addr,
          appReferences: [differentVault.appId],
          suppressLog: true,
        }),
      ).rejects.toThrow(/campaign vault is not the official vault/)

      const double = await createCampaign(fixture, stack)
      const doublePay = await stack.algorand.createTransaction.payment({
        sender: double.creator.addr,
        receiver: stack.factory.address,
        amount: microAlgos(REGISTER_MBR),
      })
      await expect(
        stack.factory.client.send.call({
          method: 'register(uint64,pay)void',
          args: [double.appId, doublePay],
          sender: double.creator.addr,
          appReferences: [double.appId],
          suppressLog: true,
        }),
      ).rejects.toThrow(/campaign already registered/)
    },
  )

  test('CON-127 Factory register deposit and group guards', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createCampaign(fixture, stack, { register: false })
    const creator = campaign.creator.addr.toString()
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const creatorBefore = await accountInfo(stack.algorand, creator)
    const factoryBefore = await accountInfo(stack.algorand, stack.factory.address)

    interface Attempt {
      amount?: bigint
      paySender?: string
      receiver?: string
      rekeyTo?: string
      trailing?: boolean
    }
    const attempt = async (options: Attempt): Promise<unknown> => {
      const pay = await stack.algorand.createTransaction.payment({
        sender: options.paySender ?? creator,
        receiver: options.receiver ?? stack.factory.address,
        amount: microAlgos(options.amount ?? REGISTER_MBR),
        ...(options.rekeyTo === undefined ? {} : { rekeyTo: options.rekeyTo }),
      })
      const composer = stack.algorand.send.newGroup()
      composer.addAppCallMethodCall({
        appId: stack.factory.appId,
        method: ABIMethod.fromSignature('register(uint64,pay)void'),
        args: [campaign.appId, pay],
        sender: creator,
        appReferences: [campaign.appId],
      })
      if (options.trailing === true) {
        composer.addPayment({ sender: creator, receiver: creator, amount: microAlgos(0n) })
      }
      return composer.send({ suppressLog: true })
    }

    await expect(attempt({ amount: REGISTER_MBR - 1n })).rejects.toThrow(/registration deposit too small/)
    await expect(attempt({ receiver: creator })).rejects.toThrow(/payment must be made to the factory/)
    await expect(attempt({ paySender: stranger.addr.toString() })).rejects.toThrow(/payment must come from the caller/)
    await expect(attempt({ trailing: true })).rejects.toThrow(/register must be the final transaction in the group/)
    await expect(attempt({ rekeyTo: creator })).rejects.toThrow(/payment must not rekey/)
    expect(await accountInfo(stack.algorand, creator)).toEqual(creatorBefore)
    expect(await accountInfo(stack.algorand, stack.factory.address)).toEqual(factoryBefore)
    expect((await campaignState(campaign.appClient)).n).toEqual(0n)
    expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)

    const unconfigured = await deployStack(fixture, { configureCampaignHash: false })
    const otherCreator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const other = await deployCampaign(unconfigured, otherCreator.addr.toString(), { register: false })
    const pay = await unconfigured.algorand.createTransaction.payment({
      sender: otherCreator.addr,
      receiver: unconfigured.factory.address,
      amount: microAlgos(REGISTER_MBR),
    })
    await expect(
      unconfigured.factory.client.send.call({
        method: 'register(uint64,pay)void',
        args: [other.appId, pay],
        sender: otherCreator.addr,
        appReferences: [other.appId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/official program hash not configured/)
  })
})
