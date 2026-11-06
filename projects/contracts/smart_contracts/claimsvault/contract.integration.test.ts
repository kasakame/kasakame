import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { ABIMethod } from 'algosdk'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  ALGO,
  APP_BASE,
  ClaimTreeOracle,
  DEPLOY_FUNDING,
  FEE,
  PLEDGE_FEES,
  VAULT_BOX_MBR,
  Z_HEX,
  advanceTime,
  balanceOf,
  campaignBox,
  campaignBoxExists,
  claimCampaign,
  concatHex,
  deleteCampaign,
  deployCampaign,
  deployStack,
  minBalanceOf,
  pledge,
  registrationBoxRef,
  spendCampaign,
  spendVault,
  vaultBoxRef,
  type ContractStack,
} from '../testing/localnet'

/**
 * LocalNet integration tests for the ClaimsVault pooling and settlement paths: two campaigns sharing one pool prove
 * per-campaign isolation, and the permissionless entries (`settleOpen`, vault `refund`, `finalize`) plus the
 * direct-credit self-harm containment run against minimal campaign fixtures. The full lifecycles live in
 * `../campaign/contract.integration.test.ts`; every assertion here is µA-exact.
 *
 * Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifacts exist.
 */

describe('ClaimsVault pooling + settlement (localnet)', () => {
  const fixture = algorandFixture()
  let stack: ContractStack
  let algorand: AlgorandClient
  let vaultClient: AppClient
  let vaultId: bigint
  let vaultAddress: string
  let factoryId: bigint

  beforeAll(async () => {
    stack = await deployStack(fixture)
    algorand = stack.algorand
    vaultClient = stack.vault.client
    vaultId = stack.vault.appId
    vaultAddress = stack.vault.address
    factoryId = stack.factory.appId
  })

  test('first touch creates the box with exact MBR accounting', async () => {
    const tree = new ClaimTreeOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const { appClient, appId } = await deployCampaign(stack, creator.addr.toString())
    expect(await campaignBoxExists(vaultClient, appId)).toEqual(false)

    const vaultBal0 = await balanceOf(algorand, vaultAddress)
    const vaultMin0 = await minBalanceOf(algorand, vaultAddress)
    expect(vaultBal0).toEqual(DEPLOY_FUNDING)
    expect(vaultMin0).toEqual(APP_BASE)
    const balB0 = await balanceOf(algorand, backer.addr.toString())
    await pledge(stack, appClient, appId, backer.addr.toString(), 2n * ALGO, tree)

    expect(await campaignBoxExists(vaultClient, appId)).toEqual(true)
    const box = await campaignBox(vaultClient, appId)
    expect(box.paidIn).toEqual(2n * ALGO)
    expect(box.paidOut).toEqual(0n)
    expect(box.status).toEqual(1)
    // The pool total rises by exactly the pledge; the new box parks 32,100 µA of minimum balance.
    expect(await balanceOf(algorand, vaultAddress)).toEqual(vaultBal0 + 2n * ALGO)
    expect(await minBalanceOf(algorand, vaultAddress)).toEqual(vaultMin0 + VAULT_BOX_MBR)
    expect(await balanceOf(algorand, backer.addr.toString())).toEqual(balB0 - 2n * ALGO - PLEDGE_FEES)
  })

  test('two campaigns share the pool with per-campaign isolation', async () => {
    const treeA = new ClaimTreeOracle()
    const treeB = new ClaimTreeOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const caddr = creator.addr.toString()
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addrA = backerA.addr.toString()
    const addrB = backerB.addr.toString()
    const { appClient: clientA, appId: idA } = await deployCampaign(stack, caddr)
    const { appClient: clientB, appId: idB } = await deployCampaign(stack, caddr)
    const vaultBal0 = await balanceOf(algorand, vaultAddress)

    const txA0 = await pledge(stack, clientA, idA, addrA, 3n * ALGO, treeA)
    const txA1 = await pledge(stack, clientA, idA, addrB, 1n * ALGO, treeA)
    await pledge(stack, clientB, idB, addrB, 2n * ALGO, treeB)

    // Drain A entirely through its campaign; B must be untouched: same root, zero paid out.
    await advanceTime(fixture, 900)
    await spendCampaign(stack, clientA, idA, addrA, 0, 3n * ALGO, txA0, 'refund(uint64,uint64,byte[],byte[])void', treeA)
    await spendCampaign(stack, clientA, idA, addrB, 1, 1n * ALGO, txA1, 'refund(uint64,uint64,byte[],byte[])void', treeA)
    const boxA = await campaignBox(vaultClient, idA)
    expect(boxA.paidOut).toEqual(boxA.paidIn)
    const boxB = await campaignBox(vaultClient, idB)
    expect(boxB.paidOut).toEqual(0n)
    // B was never settled: its box root is still Z (only settled boxes carry roots).
    expect(boxB.root).toEqual(Z_HEX)
    expect(boxB.paidIn).toEqual(2n * ALGO)
    // Pool holds exactly B's live pledge (A's 4 ALGO left; both boxes' MBR stays parked in min-balance).
    expect(await balanceOf(algorand, vaultAddress)).toEqual(vaultBal0 + 2n * ALGO)
  })

  test('settleOpen + vault refunds + zero-residual finalize', async () => {
    const tree = new ClaimTreeOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addr = backer.addr.toString()
    const stranger = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const { appClient, appId } = await deployCampaign(stack, creator.addr.toString())

    const txid = await pledge(stack, appClient, appId, addr, 2n * ALGO, tree)
    await advanceTime(fixture, 900)

    // A stranger settles the vanished-creator campaign; anyone can read the FAILED state but only the box matters.
    await vaultClient.send.call({
      method: 'settleOpen(uint64)void',
      args: [appId],
      sender: stranger.addr,
      appReferences: [appId],
      suppressLog: true,
    })
    expect((await campaignBox(vaultClient, appId)).status).toEqual(2)

    // The backer refunds straight from the vault; a second attempt fails on the nulled leaf.
    await spendVault(stack, appId, addr, 0, 2n * ALGO, txid, tree)
    const dup = tree.path(0)
    const blob = concatHex([...dup.siblings, ...(dup.top === null ? [] : [dup.top]), ...dup.lower])
    const balBDup = await balanceOf(algorand, addr)
    await expect(
      vaultClient.send.call({
        method: 'refund(uint64,uint64,uint64,byte[],byte[])void',
        args: [appId, 0n, 2n * ALGO, Buffer.from(txid, 'hex'), blob],
        sender: addr,
        boxReferences: [vaultBoxRef(vaultId, appId)],
        extraFee: microAlgos(3n * FEE),
        suppressLog: true,
      }),
    ).rejects.toThrow(/proof does not match root/)
    expect(await balanceOf(algorand, addr)).toEqual(balBDup)

    // Nothing left: finalize deletes the box with no payment even before the window closes (fully paid out).
    const vaultMin = await minBalanceOf(algorand, vaultAddress)
    const caller = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const balC0 = await balanceOf(algorand, caller.addr.toString())
    await vaultClient.send.call({
      method: 'finalize(uint64)void',
      args: [appId],
      sender: caller.addr,
      suppressLog: true,
    })
    expect(await campaignBoxExists(vaultClient, appId)).toEqual(false)
    expect(await balanceOf(algorand, caller.addr.toString())).toEqual(balC0 - FEE)
    // The box MBR returns to the spendable pool (nothing was swept).
    expect(await minBalanceOf(algorand, vaultAddress)).toEqual(vaultMin - VAULT_BOX_MBR)
  })

  test('rejects a credit without a preceding pledge', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const deviator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addr = deviator.addr.toString()
    const { appId } = await deployCampaign(stack, creator.addr.toString())

    // Pay + credit with no pledge call: the vault requires the pledge immediately before credit, so this is rejected and
    // no box is created. A donation must be expressed as a pledge (a backer who chooses not to refund).
    const balBefore = await balanceOf(algorand, addr)
    const pay = await algorand.createTransaction.payment({ sender: addr, receiver: vaultAddress, amount: microAlgos(ALGO) })
    const composer = algorand.send.newGroup()
    composer.addTransaction(pay)
    composer.addAppCallMethodCall({
      appId: vaultId,
      method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
      args: [appId, ALGO],
      sender: addr,
      appReferences: [factoryId],
      boxReferences: [vaultBoxRef(vaultId, appId), registrationBoxRef(factoryId, appId)],
      extraFee: microAlgos(FEE),
    })
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/credit must follow pledge/)
    expect(await balanceOf(algorand, addr)).toEqual(balBefore)
    expect(await campaignBoxExists(vaultClient, appId)).toEqual(false)
  })

  test('one payment cannot back two credits in one group', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const { appId } = await deployCampaign(stack, creator.addr.toString())

    const balBefore = await balanceOf(algorand, backer.addr.toString())
    const pay = await algorand.createTransaction.payment({
      sender: backer.addr,
      receiver: vaultAddress,
      amount: microAlgos(2n * ALGO),
    })
    const composer = algorand.send.newGroup()
    composer.addTransaction(pay)
    for (const note of ['credit-1', 'credit-2']) {
      composer.addAppCallMethodCall({
        appId: vaultId,
        method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
        args: [appId, 2n * ALGO],
        sender: backer.addr,
        note: new TextEncoder().encode(note),
        appReferences: [factoryId],
        boxReferences: [vaultBoxRef(vaultId, appId), registrationBoxRef(factoryId, appId)],
        extraFee: microAlgos(FEE),
      })
    }

    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/final transaction in the group/)
    expect(await balanceOf(algorand, backer.addr.toString())).toEqual(balBefore)
    expect(await campaignBoxExists(vaultClient, appId)).toEqual(false)
  })

  test('a deleted campaign cannot be pledged, so it cannot be credited', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const { appId } = await deployCampaign(stack, creator.addr.toString())

    // Delete the pristine campaign through the atomic cleanup group: the registration is removed and the app is gone.
    await deleteCampaign(stack, appId, creator.addr.toString())
    expect(await campaignBoxExists(vaultClient, appId)).toEqual(false)

    // A pledge group must fail at the pledge call (the app is gone), so the credit can never create a box for it.
    const pay = await algorand.createTransaction.payment({
      sender: backer.addr,
      receiver: vaultAddress,
      amount: microAlgos(1n),
    })
    const composer = algorand.send.newGroup()
    composer.addAppCallMethodCall({
      appId,
      method: ABIMethod.fromSignature('pledge(pay,byte[])void'),
      args: [pay, new Uint8Array()],
      sender: backer.addr,
    })
    composer.addAppCallMethodCall({
      appId: vaultId,
      method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
      args: [appId, 1n],
      sender: backer.addr,
      appReferences: [factoryId],
      boxReferences: [vaultBoxRef(vaultId, appId), registrationBoxRef(factoryId, appId)],
      extraFee: microAlgos(FEE),
    })
    await expect(composer.send({ suppressLog: true })).rejects.toThrow()
    expect(await campaignBoxExists(vaultClient, appId)).toEqual(false)
  })

  test('releaseClaimed recovers a claimed box permissionlessly; delete still works', async () => {
    const tree = new ClaimTreeOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const stranger = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const { appClient, appId } = await deployCampaign(stack, creator.addr.toString(), { goal: 2n * ALGO })
    const addr = backer.addr.toString()
    await pledge(stack, appClient, appId, addr, 2n * ALGO, tree)
    await advanceTime(fixture, 900)
    await claimCampaign(stack, appClient, appId, creator.addr.toString())
    const box = await campaignBox(vaultClient, appId)
    expect(box.status).toEqual(3)
    expect(box.paidIn).toEqual(box.paidOut)

    const vaultBal0 = await balanceOf(algorand, vaultAddress)
    const vaultMin0 = await minBalanceOf(algorand, vaultAddress)
    const strangerBefore = await balanceOf(algorand, stranger.addr.toString())
    await vaultClient.send.call({
      method: 'releaseClaimed(uint64)void',
      args: [appId],
      sender: stranger.addr,
      boxReferences: [vaultBoxRef(vaultId, appId)],
      suppressLog: true,
    })
    expect(await balanceOf(algorand, stranger.addr.toString())).toEqual(strangerBefore - FEE)
    expect(await campaignBoxExists(vaultClient, appId)).toEqual(false)
    expect(await balanceOf(algorand, vaultAddress)).toEqual(vaultBal0)
    expect(await minBalanceOf(algorand, vaultAddress)).toEqual(vaultMin0 - VAULT_BOX_MBR)

    // The campaign's creator can still delete: notifyDelete is a no-op once the box is gone.
    await deleteCampaign(stack, appId, creator.addr.toString())
  })
})
