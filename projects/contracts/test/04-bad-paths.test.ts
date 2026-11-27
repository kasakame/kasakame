import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import {
  FEE_MICRO_ALGOS,
  MICRO_ALGOS_PER_ALGO,
  MIN_REFUND_WINDOW_SECONDS,
  REGISTER_DEPOSIT_MICRO_ALGOS,
  SECONDS_PER_DAY,
} from '@kasakame/constants'
import { advanceTime, appIdBytes, concatHex, vaultBoxRef } from '@kasakame/utils/testing'
import type { Account } from 'algosdk'
import { ABIMethod, OnApplicationComplete, decodeAddress, getApplicationAddress } from 'algosdk'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  ClaimTreeOracle,
  attemptCampaignSpend,
  buildCreditGroup,
  buildPledgeGroup,
  buildRawDeleteGroup,
  buildRegisterGroup,
  buildUnregisterDeleteGroup,
  campaignBox,
  campaignBoxExists,
  campaignState,
  claimCampaign,
  createBadPathCampaign,
  deleteCampaign,
  deployCampaign,
  deployStack,
  expectRejected,
  expectSendRejected,
  failedBadPathCampaign,
  isRegistered,
  pledge,
  refundFromVault,
  settleOpen,
  spendCampaign,
  spendExtraFee,
  type CampaignFixture,
  type ContractStack,
  type CreditOptions,
  type RegisterAttemptOptions,
} from './utils'

/** A test-only inner caller whose inner `[pay, Campaign.pledge]` group is rejected by the top-level guard. */
const INNER_CALLER_TEAL = `#pragma version 11
txn ApplicationID
bnz main
int 1
return
main:
txna ApplicationArgs 0
btoi
store 0
txna ApplicationArgs 1
btoi
store 1
txna ApplicationArgs 2
store 2
itxn_begin
int pay
itxn_field TypeEnum
load 2
itxn_field Receiver
load 1
itxn_field Amount
int 0
itxn_field Fee
itxn_next
int appl
itxn_field TypeEnum
load 0
itxn_field ApplicationID
pushbytes 0xa4030bd2
itxn_field ApplicationArgs
pushbytes 0x0000
itxn_field ApplicationArgs
int 0
itxn_field Fee
itxn_submit
int 1
return
`

describe('04 bad paths', () => {
  const fixture = algorandFixture()
  let stack: ContractStack

  beforeAll(async () => {
    stack = await deployStack(fixture)
  })

  /**
   * The three official apps, with a sender allowed to attempt the call.
   *
   * @param campaign The campaign under test.
   * @returns The app/sender pairs.
   */
  const guardedApps = (campaign: CampaignFixture): { appId: bigint; sender: string }[] => [
    { appId: campaign.appId, sender: campaign.creator.addr.toString() },
    { appId: stack.vault.appId, sender: stack.ownerAddress },
    { appId: stack.registry.appId, sender: stack.ownerAddress },
  ]

  test('CON-100 creator cannot pledge to their own campaign', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const composer = await buildPledgeGroup(stack, campaign, campaign.creator.addr.toString(), { amount: 1n * MICRO_ALGOS_PER_ALGO }, [])
    await expectSendRejected(
      stack,
      campaign.appId,
      () => composer.send({ suppressLog: true }),
      /creator cannot pledge to their own campaign/,
    )
  })

  test('CON-101 pledge payment must go to the vault', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const composer = await buildPledgeGroup(
      stack,
      campaign,
      backer.addr.toString(),
      { amount: 1n * MICRO_ALGOS_PER_ALGO, receiver: campaign.creator.addr.toString() },
      [],
    )
    await expectSendRejected(stack, campaign.appId, () => composer.send({ suppressLog: true }), /payment must be made to the vault/)
  })

  test('CON-102 pledge payment sender must be the caller', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const composer = await buildPledgeGroup(
      stack,
      campaign,
      backer.addr.toString(),
      { amount: 1n * MICRO_ALGOS_PER_ALGO, sender: campaign.creator.addr.toString() },
      [],
    )
    await expectSendRejected(stack, campaign.appId, () => composer.send({ suppressLog: true }), /payment must come from the caller/)
  })

  test('CON-103 zero pledge is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const composer = await buildPledgeGroup(stack, campaign, backer.addr.toString(), { amount: 0n }, [])
    await expectSendRejected(stack, campaign.appId, () => composer.send({ suppressLog: true }), /pledge must be greater than zero/)
  })

  test('CON-104 pledge below the minimum is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const composer = await buildPledgeGroup(stack, campaign, backer.addr.toString(), { amount: 1n }, [])
    await expectSendRejected(stack, campaign.appId, () => composer.send({ suppressLog: true }), /pledge below minimum/)
  })

  test('CON-105 stale frontier after a real pledge is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })

    await pledge(stack, campaign.appClient, campaign.appId, backerA.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, campaign.oracle)
    const staleFrontier = campaign.oracle
      .frontier()
      .peaks.map((peak) => (peak.slice(0, 2) === '00' ? `01${peak.slice(2)}` : `00${peak.slice(2)}`))
    const composer = await buildPledgeGroup(stack, campaign, backerB.addr.toString(), { amount: 1n * MICRO_ALGOS_PER_ALGO }, staleFrontier)
    await expectSendRejected(stack, campaign.appId, () => composer.send({ suppressLog: true }), /stale or forged frontier/)
  })

  test('CON-106 pledge without the matching credit is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const composer = await buildPledgeGroup(stack, campaign, backer.addr.toString(), { amount: 1n * MICRO_ALGOS_PER_ALGO }, [], false)
    await expectSendRejected(stack, campaign.appId, () => composer.send({ suppressLog: true }), /credit must follow pledge/)
    expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
  })

  test('CON-107 unregistered campaign cannot be credited', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack, { register: false })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const composer = await buildPledgeGroup(stack, campaign, backer.addr.toString(), { amount: 1n * MICRO_ALGOS_PER_ALGO }, [])
    await expectSendRejected(stack, campaign.appId, () => composer.send({ suppressLog: true }), /campaign not registered/)
    expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
  })

  test('CON-108 cancel after the deadline is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txid = await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, campaign.oracle)
    const path = campaign.oracle.path(0)
    await advanceTime(fixture, SECONDS_PER_DAY)

    await expectSendRejected(
      stack,
      campaign.appId,
      () =>
        attemptCampaignSpend(
          stack,
          campaign,
          backer,
          0,
          1n * MICRO_ALGOS_PER_ALGO,
          txid,
          path,
          'cancelPledge(uint64,uint64,byte[],byte[])void',
        ),
      /pledging is closed/,
      { accounts: [backer.addr.toString()], campaignBox: campaign.appId },
    )
  })

  test('CON-130 final-day cancel that would drop the goal is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack, { goal: 2n * MICRO_ALGOS_PER_ALGO, deadlineOffset: 2 * SECONDS_PER_DAY })
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txidA = await pledge(
      stack,
      campaign.appClient,
      campaign.appId,
      backerA.addr.toString(),
      1n * MICRO_ALGOS_PER_ALGO,
      campaign.oracle,
    )
    await pledge(stack, campaign.appClient, campaign.appId, backerB.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, campaign.oracle)
    await advanceTime(fixture, SECONDS_PER_DAY + 60)

    const path = campaign.oracle.path(0)
    await expectSendRejected(
      stack,
      campaign.appId,
      () =>
        attemptCampaignSpend(
          stack,
          campaign,
          backerA,
          0,
          1n * MICRO_ALGOS_PER_ALGO,
          txidA,
          path,
          'cancelPledge(uint64,uint64,byte[],byte[])void',
        ),
      /cancel would drop below goal in the final day/,
      { accounts: [backerA.addr.toString()], campaignBox: campaign.appId },
    )
    expect((await campaignState(campaign.appClient)).raised).toEqual(2n * MICRO_ALGOS_PER_ALGO)
  })

  test('CON-131 final-day cancel that keeps the goal is allowed', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack, { goal: 1n * MICRO_ALGOS_PER_ALGO, deadlineOffset: 2 * SECONDS_PER_DAY })
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txidA = await pledge(
      stack,
      campaign.appClient,
      campaign.appId,
      backerA.addr.toString(),
      1n * MICRO_ALGOS_PER_ALGO,
      campaign.oracle,
    )
    await pledge(stack, campaign.appClient, campaign.appId, backerB.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, campaign.oracle)
    await advanceTime(fixture, SECONDS_PER_DAY + 60)

    await spendCampaign(
      stack,
      campaign.appClient,
      campaign.appId,
      backerA.addr.toString(),
      0,
      1n * MICRO_ALGOS_PER_ALGO,
      txidA,
      'cancelPledge(uint64,uint64,byte[],byte[])void',
      campaign.oracle,
    )
    expect((await campaignState(campaign.appClient)).raised).toEqual(1n * MICRO_ALGOS_PER_ALGO)
  })

  test('CON-132 a goal-dropping cancel before the final day is allowed', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack, { goal: 2n * MICRO_ALGOS_PER_ALGO, deadlineOffset: 2 * SECONDS_PER_DAY })
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txidA = await pledge(
      stack,
      campaign.appClient,
      campaign.appId,
      backerA.addr.toString(),
      1n * MICRO_ALGOS_PER_ALGO,
      campaign.oracle,
    )
    await pledge(stack, campaign.appClient, campaign.appId, backerB.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, campaign.oracle)

    await spendCampaign(
      stack,
      campaign.appClient,
      campaign.appId,
      backerA.addr.toString(),
      0,
      1n * MICRO_ALGOS_PER_ALGO,
      txidA,
      'cancelPledge(uint64,uint64,byte[],byte[])void',
      campaign.oracle,
    )
    expect((await campaignState(campaign.appClient)).raised).toEqual(1n * MICRO_ALGOS_PER_ALGO)
  })

  test('CON-109 refund before the deadline is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txid = await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, campaign.oracle)
    const path = campaign.oracle.path(0)

    await expectSendRejected(
      stack,
      campaign.appId,
      () =>
        attemptCampaignSpend(stack, campaign, backer, 0, 1n * MICRO_ALGOS_PER_ALGO, txid, path, 'refund(uint64,uint64,byte[],byte[])void'),
      /deadline has not passed/,
      { accounts: [backer.addr.toString()], campaignBox: campaign.appId },
    )
  })

  test('CON-110 refund after the goal was reached is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack, { goal: 1n * MICRO_ALGOS_PER_ALGO })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txid = await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 2n * MICRO_ALGOS_PER_ALGO, campaign.oracle)
    const path = campaign.oracle.path(0)
    await advanceTime(fixture, SECONDS_PER_DAY)

    await expectSendRejected(
      stack,
      campaign.appId,
      () =>
        attemptCampaignSpend(stack, campaign, backer, 0, 2n * MICRO_ALGOS_PER_ALGO, txid, path, 'refund(uint64,uint64,byte[],byte[])void'),
      /goal was reached, no refunds/,
      { accounts: [backer.addr.toString()], campaignBox: campaign.appId },
    )
  })

  test('CON-111 only the creator can claim', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack, { goal: 1n * MICRO_ALGOS_PER_ALGO })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, campaign.oracle)
    await advanceTime(fixture, SECONDS_PER_DAY)

    await expectSendRejected(
      stack,
      campaign.appId,
      () =>
        campaign.appClient.send.call({
          method: 'claim()void',
          args: [],
          sender: backer.addr,
          appReferences: [stack.vault.appId],
          boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
          extraFee: microAlgos(2n * FEE_MICRO_ALGOS),
          suppressLog: true,
        }),
      /only the creator can claim/,
      { accounts: [backer.addr.toString()], campaignBox: campaign.appId },
    )
  })

  test('CON-112 raw delete is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, campaign.oracle)

    const composer = buildRawDeleteGroup(stack, campaign, campaign.creator)
    await expectSendRejected(stack, campaign.appId, () => composer.send({ suppressLog: true }), /unregister must precede delete/, {
      campaignBox: campaign.appId,
    })
  })

  test('CON-113 a live campaign cannot be unregistered', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, campaign.oracle)

    const composer = buildUnregisterDeleteGroup(stack, campaign.appId, {
      unregisterSender: campaign.creator,
      deleteSender: campaign.creator,
    })
    await expectSendRejected(stack, campaign.appId, () => composer.send({ suppressLog: true }), /campaign is still live/, {
      campaignBox: campaign.appId,
    })

    const pristine = await createBadPathCampaign(fixture, stack)
    const stranger = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const strangerGroup = buildUnregisterDeleteGroup(stack, pristine.appId, {
      unregisterSender: stranger,
      deleteSender: pristine.creator,
      declareVaultBox: false,
    })
    await expectSendRejected(
      stack,
      stack.registry.appId,
      () => strangerGroup.send({ suppressLog: true }),
      /only the campaign creator can unregister/,
    )
    expect(await isRegistered(stack.registry.client, pristine.appId, stack.ownerAddress)).toEqual(true)
  })

  test('CON-114 credit without a preceding pledge is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const composer = await buildCreditGroup(stack, campaign, backer, 1n * MICRO_ALGOS_PER_ALGO)
    await expectSendRejected(stack, stack.vault.appId, () => composer.send({ suppressLog: true }), /credit must follow pledge/, {
      accounts: [backer.addr.toString()],
      campaignBox: campaign.appId,
    })
  })

  test('CON-115 top-level vault inner methods are rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const stranger = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, campaign.oracle)

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

  test('CON-129 an app cannot pledge through an inner group', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const attacker = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })

    const { appId: callerAppId } = await stack.algorand.send.appCreate({
      sender: attacker.addr,
      approvalProgram: INNER_CALLER_TEAL,
      clearStateProgram: '#pragma version 11\nint 1',
      schema: { globalInts: 0, globalByteSlices: 0, localInts: 0, localByteSlices: 0 },
      suppressLog: true,
    })
    await stack.algorand.send.payment({
      sender: attacker.addr,
      receiver: getApplicationAddress(callerAppId).toString(),
      amount: microAlgos(1n * MICRO_ALGOS_PER_ALGO),
      suppressLog: true,
    })

    const amount = 100_000n
    await expect(
      stack.algorand.send.appCall({
        sender: attacker.addr,
        appId: callerAppId,
        args: [appIdBytes(campaign.appId), appIdBytes(amount), decodeAddress(stack.vault.address).publicKey],
        appReferences: [campaign.appId],
        accountReferences: [stack.vault.address],
        extraFee: microAlgos(2n * FEE_MICRO_ALGOS),
        suppressLog: true,
      }),
    ).rejects.toThrow(/must be called from the top level/)
  })

  test('CON-118 an impostor campaign cannot register', { tags: ['bad', 'always'] }, async () => {
    const composer = await buildRegisterGroup(stack, stack.registry.appId, { sender: stack.owner })
    await expectSendRejected(stack, stack.registry.appId, () => composer.send({ suppressLog: true }), /not an official kasakame campaign/, {
      accounts: [stack.ownerAddress],
    })
  })

  test(
    'CON-119 vault refund rejects an open box, a claimed box, a closed window, and an unknown position',
    { tags: ['bad', 'always'] },
    async () => {
      const open = await failedBadPathCampaign(fixture, stack)
      const openState = await campaignState(open.campaign.appClient)
      await expectSendRejected(
        stack,
        stack.vault.appId,
        () => refundFromVault(stack, open.campaign, open.backer, 0, 1n * MICRO_ALGOS_PER_ALGO, open.txid, open.campaign.oracle.path(0)),
        /campaign is not refundable/,
        { campaignBox: open.campaign.appId },
      )
      expect(await campaignState(open.campaign.appClient)).toEqual(openState)

      const claimedCreator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      const claimedBacker = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      const claimed = await deployCampaign(stack, claimedCreator.addr.toString(), { goal: 1n * MICRO_ALGOS_PER_ALGO })
      const claimedOracle = new ClaimTreeOracle('claimed-guard-')
      const claimedTxid = await pledge(
        stack,
        claimed.appClient,
        claimed.appId,
        claimedBacker.addr.toString(),
        1n * MICRO_ALGOS_PER_ALGO,
        claimedOracle,
      )
      await advanceTime(fixture, SECONDS_PER_DAY)
      await claimCampaign(stack, claimed.appClient, claimed.appId, claimedCreator.addr.toString())
      await expectSendRejected(
        stack,
        stack.vault.appId,
        () =>
          refundFromVault(
            stack,
            { ...claimed, creator: claimedCreator, oracle: claimedOracle },
            claimedBacker,
            0,
            1n * MICRO_ALGOS_PER_ALGO,
            claimedTxid,
            claimedOracle.path(0),
          ),
        /campaign is not refundable/,
        { campaignBox: claimed.appId },
      )

      const window = await failedBadPathCampaign(fixture, stack)
      await deleteCampaign(stack, window.campaign.appId, window.campaign.creator.addr.toString())
      await advanceTime(fixture, MIN_REFUND_WINDOW_SECONDS + 4_000)
      await expectSendRejected(
        stack,
        stack.vault.appId,
        () =>
          refundFromVault(stack, window.campaign, window.backer, 0, 1n * MICRO_ALGOS_PER_ALGO, window.txid, window.campaign.oracle.path(0)),
        /refund window closed/,
        { campaignBox: window.campaign.appId },
      )

      const unknown = await failedBadPathCampaign(fixture, stack)
      await deleteCampaign(stack, unknown.campaign.appId, unknown.campaign.creator.addr.toString())
      await expectSendRejected(
        stack,
        stack.vault.appId,
        () =>
          stack.vault.client.send.call({
            method: 'refund(uint64,uint64,uint64,byte[],byte[])void',
            args: [unknown.campaign.appId, 1n, 1n * MICRO_ALGOS_PER_ALGO, Buffer.from(unknown.txid, 'hex'), new Uint8Array()],
            sender: unknown.backer.addr,
            boxReferences: [vaultBoxRef(stack.vault.appId, unknown.campaign.appId)],
            extraFee: microAlgos(FEE_MICRO_ALGOS),
            suppressLog: true,
          }),
        /unknown position/,
        { campaignBox: unknown.campaign.appId },
      )
    },
  )

  test(
    'CON-120 settleOpen rejects before the deadline, after the goal, on a claimed box, and on a failed box',
    { tags: ['bad', 'always'] },
    async () => {
      const early = await createBadPathCampaign(fixture, stack)
      const earlyBacker = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      await pledge(stack, early.appClient, early.appId, earlyBacker.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, early.oracle)
      const earlyState = await campaignState(early.appClient)
      await expectSendRejected(
        stack,
        early.appId,
        () => settleOpen(stack, early.appId, earlyBacker.addr.toString()),
        /deadline has not passed/,
        { accounts: [earlyBacker.addr.toString()], campaignBox: early.appId },
      )
      expect(await campaignState(early.appClient)).toEqual(earlyState)

      const goal = await createBadPathCampaign(fixture, stack, { goal: 1n * MICRO_ALGOS_PER_ALGO })
      const goalBacker = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      await pledge(stack, goal.appClient, goal.appId, goalBacker.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, goal.oracle)
      await advanceTime(fixture, SECONDS_PER_DAY)
      await expectSendRejected(stack, goal.appId, () => settleOpen(stack, goal.appId, goalBacker.addr.toString()), /goal was reached/, {
        accounts: [goalBacker.addr.toString()],
        campaignBox: goal.appId,
      })

      const claimedCreator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      const claimedBacker = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      const claimed = await deployCampaign(stack, claimedCreator.addr.toString(), { goal: 1n * MICRO_ALGOS_PER_ALGO })
      const claimedOracle = new ClaimTreeOracle('settle-claimed-')
      await pledge(stack, claimed.appClient, claimed.appId, claimedBacker.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, claimedOracle)
      await advanceTime(fixture, SECONDS_PER_DAY)
      await claimCampaign(stack, claimed.appClient, claimed.appId, claimedCreator.addr.toString())
      await expectSendRejected(
        stack,
        claimed.appId,
        () => settleOpen(stack, claimed.appId, claimedBacker.addr.toString()),
        /campaign is not open/,
        { accounts: [claimedBacker.addr.toString()], campaignBox: claimed.appId },
      )

      const failed = await failedBadPathCampaign(fixture, stack)
      await deleteCampaign(stack, failed.campaign.appId, failed.campaign.creator.addr.toString())
      await expectSendRejected(
        stack,
        failed.campaign.appId,
        () => settleOpen(stack, failed.campaign.appId, failed.backer.addr.toString()),
        /campaign is not open/,
        { accounts: [failed.backer.addr.toString()], campaignBox: failed.campaign.appId },
      )
    },
  )

  test('CON-121 releaseClaimed rejects a non-claimed box', { tags: ['bad', 'always'] }, async () => {
    const failed = await failedBadPathCampaign(fixture, stack)
    await deleteCampaign(stack, failed.campaign.appId, failed.campaign.creator.addr.toString())
    await expectSendRejected(
      stack,
      stack.vault.appId,
      () =>
        stack.vault.client.send.call({
          method: 'releaseClaimed(uint64)void',
          args: [failed.campaign.appId],
          sender: failed.backer.addr,
          boxReferences: [vaultBoxRef(stack.vault.appId, failed.campaign.appId)],
          suppressLog: true,
        }),
      /campaign not claimed/,
      { accounts: [failed.backer.addr.toString()], campaignBox: failed.campaign.appId },
    )
  })

  test('CON-122 pledge payment cannot close or rekey', { tags: ['bad', 'always'] }, async () => {
    const close = await createBadPathCampaign(fixture, stack)
    const closeBacker = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const closeFrontier = close.oracle.frontier().peaks
    const closeComposer = await buildPledgeGroup(
      stack,
      close,
      closeBacker.addr.toString(),
      { amount: 1n * MICRO_ALGOS_PER_ALGO, closeRemainderTo: close.creator.addr.toString(), feePayer: stack.ownerAddress },
      closeFrontier,
    )
    await expectSendRejected(stack, close.appId, () => closeComposer.send({ suppressLog: true }), /payment must not close/, {
      accounts: [closeBacker.addr.toString()],
      campaignBox: close.appId,
    })

    const rekey = await createBadPathCampaign(fixture, stack)
    const rekeyBacker = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const rekeyFrontier = rekey.oracle.frontier().peaks
    const rekeyComposer = await buildPledgeGroup(
      stack,
      rekey,
      rekeyBacker.addr.toString(),
      { amount: 1n * MICRO_ALGOS_PER_ALGO, rekeyTo: rekey.creator.addr.toString() },
      rekeyFrontier,
    )
    await expectSendRejected(stack, rekey.appId, () => rekeyComposer.send({ suppressLog: true }), /payment must not rekey/, {
      accounts: [rekeyBacker.addr.toString()],
      campaignBox: rekey.appId,
    })
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
        { credit: { amount: 2n * MICRO_ALGOS_PER_ALGO }, message: /credit amount mismatch/ },
        { credit: { appId: stack.registry.appId }, message: /credit must call the vault/ },
        { credit: { rawSelector: new Uint8Array(4) }, message: /credit selector mismatch/ },
        { credit: { trailingTxn: true }, message: /final transaction in the group/ },
        { credit: { count: 2 }, message: /final transaction in the group/ },
      ]
      for (const { credit, message } of cases) {
        const campaign = await createBadPathCampaign(fixture, stack)
        const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
        const frontier = campaign.oracle.frontier().peaks
        const composer = await buildPledgeGroup(
          stack,
          campaign,
          backer.addr.toString(),
          { amount: 1n * MICRO_ALGOS_PER_ALGO },
          frontier,
          credit,
        )
        await expectSendRejected(stack, campaign.appId, () => composer.send({ suppressLog: true }), message, {
          accounts: [backer.addr.toString()],
          campaignBox: campaign.appId,
        })
      }
    },
  )

  test('CON-124 a deleted campaign cannot be pledged or credited', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    await deleteCampaign(stack, campaign.appId, campaign.creator.addr.toString())
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const frontier = campaign.oracle.frontier().peaks
    const composer = await buildPledgeGroup(stack, campaign, backer.addr.toString(), { amount: 1n * MICRO_ALGOS_PER_ALGO }, frontier)
    await expectSendRejected(stack, campaign.appId, () => composer.send({ suppressLog: true }), undefined, {
      accounts: [backer.addr.toString()],
      campaignBox: campaign.appId,
    })
  })

  test('CON-125 double spends and stale proofs are rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txidA = await pledge(
      stack,
      campaign.appClient,
      campaign.appId,
      backerA.addr.toString(),
      1n * MICRO_ALGOS_PER_ALGO,
      campaign.oracle,
    )
    const txidB = await pledge(
      stack,
      campaign.appClient,
      campaign.appId,
      backerB.addr.toString(),
      1n * MICRO_ALGOS_PER_ALGO,
      campaign.oracle,
    )
    const oldPathA = campaign.oracle.path(0)
    const oldPathB = campaign.oracle.path(1)

    await spendCampaign(
      stack,
      campaign.appClient,
      campaign.appId,
      backerA.addr.toString(),
      0,
      1n * MICRO_ALGOS_PER_ALGO,
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
        args: [BigInt(k), 1n * MICRO_ALGOS_PER_ALGO, Buffer.from(txid, 'hex'), blob],
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
        args: [1n, 1n * MICRO_ALGOS_PER_ALGO, Buffer.from(txidB, 'hex'), currentBlob],
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
      1n * MICRO_ALGOS_PER_ALGO,
      txidB,
      'cancelPledge(uint64,uint64,byte[],byte[])void',
      campaign.oracle,
    )
  })

  test('CON-133 a stranger cannot spend a victim’s proof', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const victim = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const stranger = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txid = await pledge(stack, campaign.appClient, campaign.appId, victim.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, campaign.oracle)
    const path = campaign.oracle.path(0)

    await expectSendRejected(
      stack,
      campaign.appId,
      () =>
        attemptCampaignSpend(
          stack,
          campaign,
          stranger,
          0,
          1n * MICRO_ALGOS_PER_ALGO,
          txid,
          path,
          'cancelPledge(uint64,uint64,byte[],byte[])void',
        ),
      /proof does not match root/,
      { accounts: [victim.addr.toString(), stack.vault.address], campaignBox: campaign.appId },
    )

    await spendCampaign(
      stack,
      campaign.appClient,
      campaign.appId,
      victim.addr.toString(),
      0,
      1n * MICRO_ALGOS_PER_ALGO,
      txid,
      'cancelPledge(uint64,uint64,byte[],byte[])void',
      campaign.oracle,
    )
  })

  test('CON-134 a proof from one campaign cannot be replayed on another', { tags: ['bad', 'always'] }, async () => {
    const campaignA = await createBadPathCampaign(fixture, stack)
    const campaignB = await createBadPathCampaign(fixture, stack)
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txidA = await pledge(
      stack,
      campaignA.appClient,
      campaignA.appId,
      backer.addr.toString(),
      1n * MICRO_ALGOS_PER_ALGO,
      campaignA.oracle,
    )
    const txidB = await pledge(
      stack,
      campaignB.appClient,
      campaignB.appId,
      backer.addr.toString(),
      1n * MICRO_ALGOS_PER_ALGO,
      campaignB.oracle,
    )
    const pathA = campaignA.oracle.path(0)

    await expectSendRejected(
      stack,
      campaignB.appId,
      () =>
        attemptCampaignSpend(
          stack,
          campaignB,
          backer,
          0,
          1n * MICRO_ALGOS_PER_ALGO,
          txidA,
          pathA,
          'cancelPledge(uint64,uint64,byte[],byte[])void',
        ),
      /proof does not match root/,
      { accounts: [stack.vault.address], campaignBox: campaignB.appId },
    )

    await spendCampaign(
      stack,
      campaignB.appClient,
      campaignB.appId,
      backer.addr.toString(),
      0,
      1n * MICRO_ALGOS_PER_ALGO,
      txidB,
      'cancelPledge(uint64,uint64,byte[],byte[])void',
      campaignB.oracle,
    )
  })

  test('CON-135 a valid proof with a changed amount or position is rejected', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const txidA = await pledge(
      stack,
      campaign.appClient,
      campaign.appId,
      backerA.addr.toString(),
      1n * MICRO_ALGOS_PER_ALGO,
      campaign.oracle,
    )
    await pledge(stack, campaign.appClient, campaign.appId, backerB.addr.toString(), 1n * MICRO_ALGOS_PER_ALGO, campaign.oracle)
    const pathA = campaign.oracle.path(0)

    await expectSendRejected(
      stack,
      campaign.appId,
      () =>
        attemptCampaignSpend(
          stack,
          campaign,
          backerA,
          0,
          1n * MICRO_ALGOS_PER_ALGO + 1n,
          txidA,
          pathA,
          'cancelPledge(uint64,uint64,byte[],byte[])void',
        ),
      /proof does not match root/,
      { accounts: [stack.vault.address], campaignBox: campaign.appId },
    )

    await expectSendRejected(
      stack,
      campaign.appId,
      () =>
        attemptCampaignSpend(
          stack,
          campaign,
          backerA,
          1,
          1n * MICRO_ALGOS_PER_ALGO,
          txidA,
          pathA,
          'cancelPledge(uint64,uint64,byte[],byte[])void',
        ),
      /proof does not match root/,
      { accounts: [stack.vault.address], campaignBox: campaign.appId },
    )

    await spendCampaign(
      stack,
      campaign.appClient,
      campaign.appId,
      backerA.addr.toString(),
      0,
      1n * MICRO_ALGOS_PER_ALGO,
      txidA,
      'cancelPledge(uint64,uint64,byte[],byte[])void',
      campaign.oracle,
    )
  })

  test(
    'CON-126 Registry register rejects non-creators, different vaults, and double registration',
    { tags: ['bad', 'always'] },
    async () => {
      const nonCreatorCampaign = await createBadPathCampaign(fixture, stack, { register: false })
      const stranger = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
      const nonCreatorComposer = await buildRegisterGroup(stack, nonCreatorCampaign.appId, { sender: stranger })
      await expectSendRejected(
        stack,
        stack.registry.appId,
        () => nonCreatorComposer.send({ suppressLog: true }),
        /only the campaign creator can register/,
        { accounts: [stranger.addr.toString()] },
      )

      const differentVault = await createBadPathCampaign(fixture, stack, { register: false, vaultId: stack.registry.appId })
      const differentComposer = await buildRegisterGroup(stack, differentVault.appId, { sender: differentVault.creator })
      await expectSendRejected(
        stack,
        stack.registry.appId,
        () => differentComposer.send({ suppressLog: true }),
        /campaign vault is not the official vault/,
        { accounts: [differentVault.creator.addr.toString()] },
      )

      const double = await createBadPathCampaign(fixture, stack)
      const doubleComposer = await buildRegisterGroup(stack, double.appId, { sender: double.creator })
      await expectSendRejected(
        stack,
        stack.registry.appId,
        () => doubleComposer.send({ suppressLog: true }),
        /campaign already registered/,
        { accounts: [double.creator.addr.toString()] },
      )
    },
  )

  test('CON-127 Registry register deposit and group guards', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack, { register: false })
    const creator = campaign.creator.addr.toString()
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })

    const expectRegisterRejected = async (options: Partial<RegisterAttemptOptions>, message: RegExp): Promise<void> => {
      const composer = await buildRegisterGroup(stack, campaign.appId, { sender: campaign.creator, ...options })
      await expectSendRejected(stack, stack.registry.appId, () => composer.send({ suppressLog: true }), message, {
        accounts: [creator, stack.registry.address],
      })
    }

    await expectRegisterRejected({ amount: REGISTER_DEPOSIT_MICRO_ALGOS - 1n }, /registration deposit must be exact/)
    await expectRegisterRejected({ amount: REGISTER_DEPOSIT_MICRO_ALGOS + 1n }, /registration deposit must be exact/)
    await expectRegisterRejected({ receiver: creator }, /payment must be made to the registry/)
    await expectRegisterRejected({ sender: campaign.creator, paymentSender: stranger }, /payment must come from the caller/)
    await expectRegisterRejected({ trailing: true }, /register must be the final transaction in the group/)
    await expectRegisterRejected({ rekeyTo: creator }, /payment must not rekey/)
    expect((await campaignState(campaign.appClient)).n).toEqual(0n)
    expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
  })

  test('CON-128 create accepts 123/117 byte metadata and rejects 124/118', { tags: ['bad', 'always'] }, async () => {
    const creator = stack.owner.addr.toString()
    const campaign = await deployCampaign(stack, creator, {
      title: 't'.repeat(123),
      uri: 'u'.repeat(117),
    })
    const title = (await campaign.appClient.state.global.getValue('title')) as Uint8Array
    const uri = (await campaign.appClient.state.global.getValue('metadataUri')) as Uint8Array
    expect(title.length).toEqual(123)
    expect(uri.length).toEqual(117)

    await expect(deployCampaign(stack, creator, { title: 't'.repeat(124) })).rejects.toThrow(/title must be 123 bytes or fewer/)
    await expect(deployCampaign(stack, creator, { uri: 'u'.repeat(118) })).rejects.toThrow(/metadata uri must be 117 bytes or fewer/)
  })

  test('CON-250 UpdateApplication is rejected on Campaign, ClaimsVault, and Registry', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    for (const { appId, sender } of guardedApps(campaign)) {
      const { params } = await stack.algorand.client.algod.getApplicationByID(appId).do()
      if (params === undefined) throw new Error(`app ${appId.toString()} has no params`)
      await expectRejected(stack, appId, (composer) => {
        composer.addAppUpdate({
          sender,
          appId,
          approvalProgram: params.clearStateProgram,
          clearStateProgram: params.clearStateProgram,
        })
      })
    }
  })

  test('CON-251 raw DeleteApplication is rejected on Campaign, ClaimsVault, and Registry', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    for (const { appId, sender } of guardedApps(campaign)) {
      await expectRejected(stack, appId, (composer) => {
        composer.addAppDelete({ sender, appId })
      })
      await expectRejected(stack, appId, (composer) => {
        composer.addAppDelete({ sender, appId, args: [new Uint8Array(4)] })
      })
    }
  })

  test('CON-252 OptIn and CloseOut are rejected on Campaign, ClaimsVault, and Registry', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    for (const { appId, sender } of guardedApps(campaign)) {
      for (const onComplete of [OnApplicationComplete.OptInOC, OnApplicationComplete.CloseOutOC] as const) {
        await expectRejected(stack, appId, (composer) => {
          composer.addAppCall({ sender, appId, onComplete })
        })
      }
    }
  })

  test('CON-253 ClearState cannot delete or alter the apps', { tags: ['bad', 'always'] }, async () => {
    const campaign = await createBadPathCampaign(fixture, stack)
    for (const { appId, sender } of guardedApps(campaign)) {
      await expectRejected(stack, appId, (composer) => {
        composer.addAppCall({ sender, appId, onComplete: OnApplicationComplete.ClearStateOC })
      })
    }
  })
})
