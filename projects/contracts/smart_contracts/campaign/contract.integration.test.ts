import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { ABIMethod } from 'algosdk'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  ALGO,
  CAMPAIGN_MBR,
  CLEANUP_FEES,
  CREATE_FEE,
  ClaimTreeOracle,
  FEE,
  FEE_CLAIM,
  FEE_DELETE_SETTLED,
  FEE_UNREGISTER,
  PLEDGE_FEES,
  REGISTER_FEES,
  REGISTER_MBR,
  SELECTORS,
  VAULT_BOX_MBR,
  advanceTime,
  balanceOf,
  campaignBox,
  campaignBoxExists,
  campaignState,
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
 * LocalNet integration tests for the claim-tree architecture: deploy the Factory + ClaimsVault + Campaign v2 TEAL to a
 * live algod and exercise full lifecycles end-to-end with **differential tree assertions and fund accounting** - every
 * pledge/cancel/refund asserts root/n/raised (and the vault box's paidIn/paidOut) against the Python reference oracle
 * (`../oracle.py`), driven with the REAL confirmed payment TxIDs; every payout asserts µA-exact fund movement; and the
 * attack matrix covers double-spends, stale/forged proofs, unregistered credit, top-level inner-only calls, the
 * settleOpen interplay, and window enforcement.
 *
 * Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifacts exist.
 */

describe('Campaign + ClaimsVault claim-tree (localnet)', () => {
  const fixture = algorandFixture()
  let stack: ContractStack
  let algorand: AlgorandClient
  let oracle: ClaimTreeOracle
  let vaultClient: AppClient
  let vaultId: bigint
  let vaultAddress: string
  let factoryId: bigint
  let sweeperAddr: string

  beforeAll(async () => {
    stack = await deployStack(fixture)
    algorand = stack.algorand
    vaultClient = stack.vault.client
    vaultId = stack.vault.appId
    vaultAddress = stack.vault.address
    factoryId = stack.factory.appId
    sweeperAddr = stack.sweeperAddress
  })

  test('embedded vault selectors and pinned creator totals', () => {
    const approval = fs.readFileSync(path.resolve(__dirname, '../artifacts/campaign/Campaign.approval.teal'), 'utf8')
    for (const selector of [SELECTORS.payBack, SELECTORS.payClaim, SELECTORS.settle, SELECTORS.notifyDelete, SELECTORS.credit]) {
      expect(approval).toContain(selector)
    }
    const vaultApproval = fs.readFileSync(path.resolve(__dirname, '../artifacts/claimsvault/ClaimsVault.approval.teal'), 'utf8')
    expect(vaultApproval).toContain(SELECTORS.isRegistered)
    // The vault embeds the campaign pledge selector (credit must follow a pledge).
    expect(vaultApproval).toContain(SELECTORS.pledge)

    // The Factory embeds the campaign delete selector (unregister must be followed by delete).
    const factoryApproval = fs.readFileSync(path.resolve(__dirname, '../artifacts/factory/Factory.approval.teal'), 'utf8')
    expect(factoryApproval).toContain(SELECTORS.delete)

    // Pinned totals from docs/limits.md; the lifecycle tests assert the components on-chain.
    expect(CAMPAIGN_MBR + REGISTER_MBR).toEqual(589_900n)
    expect(CREATE_FEE + REGISTER_FEES).toEqual(3_000n)
    expect(CREATE_FEE + REGISTER_FEES + CLEANUP_FEES).toEqual(8_000n)
  })

  test('pledge → cancel → refund lifecycle, differentially verified with exact fund movement', async () => {
    oracle = new ClaimTreeOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addrA = backerA.addr.toString()
    const addrB = backerB.addr.toString()
    const { appClient, appId } = await deployCampaign(stack, creator.addr.toString())

    const balA0 = await balanceOf(algorand, addrA)
    const vaultBal0 = await balanceOf(algorand, vaultAddress)

    // Four pledges (A re-pledges): N=4, raised=7 ALGO. First touch carries the factory check fee.
    const txA1 = await pledge(stack, appClient, appId, addrA, 3n * ALGO, oracle)
    const txB1 = await pledge(stack, appClient, appId, addrB, 1n * ALGO, oracle)
    const txA2 = await pledge(stack, appClient, appId, addrA, 2n * ALGO, oracle)
    const txB2 = await pledge(stack, appClient, appId, addrB, 1n * ALGO, oracle)
    expect(await balanceOf(algorand, vaultAddress)).toEqual(vaultBal0 + 7n * ALGO)
    // A pledged twice: 2 payments + 2 pledge calls + 2 credits (extraFee headroom charged on each).
    expect(await balanceOf(algorand, addrA)).toEqual(balA0 - 5n * ALGO - 2n * PLEDGE_FEES)

    // Forged frontier: same length, one flipped byte - the fold check rejects, state untouched.
    const front = oracle.frontier()
    const forged = Buffer.concat(front.peaks.map((p) => Buffer.from(p, 'hex')))
    forged[0] = forged[0] === 0 ? 1 : 0
    const backerBeforeForged = await balanceOf(algorand, addrA)
    const forgedPay = await algorand.createTransaction.payment({ sender: addrA, receiver: vaultAddress, amount: microAlgos(ALGO) })
    await expect(
      appClient.send.call({
        method: 'pledge(pay,byte[])void',
        args: [forgedPay, new Uint8Array(forged)],
        sender: addrA,
        extraFee: microAlgos(2n * FEE),
        suppressLog: true,
      }),
    ).rejects.toThrow(/stale or forged frontier/)
    expect(await balanceOf(algorand, addrA)).toEqual(backerBeforeForged)
    const oracleState = oracle.state()
    const st = await campaignState(appClient)
    expect(st.n).toEqual(BigInt(oracleState.n))

    // Cancel A's second pledge pre-deadline (differential).
    await spendCampaign(stack, appClient, appId, addrA, 2, 2n * ALGO, txA2, 'cancelPledge(uint64,uint64,byte[],byte[])void', oracle)

    // Past the deadline with raised (5 ALGO) < goal: failed. Refund B then A, non-sequentially.
    await advanceTime(fixture, 900)
    await spendCampaign(stack, appClient, appId, addrB, 1, 1n * ALGO, txB1, 'refund(uint64,uint64,byte[],byte[])void', oracle)
    await spendCampaign(stack, appClient, appId, addrA, 0, 3n * ALGO, txA1, 'refund(uint64,uint64,byte[],byte[])void', oracle)
    await spendCampaign(stack, appClient, appId, addrB, 3, 1n * ALGO, txB2, 'refund(uint64,uint64,byte[],byte[])void', oracle)
    const end = await campaignState(appClient)
    expect(end.raised).toEqual(0n)
    expect(end.status).toEqual(1n)

    // Double refund of k=0: the leaf holds Z now.
    const dup = oracle.path(0)
    const blob = concatHex([...dup.siblings, ...(dup.top === null ? [] : [dup.top]), ...dup.lower])
    const backerBeforeDup = await balanceOf(algorand, addrA)
    await expect(
      appClient.send.call({
        method: 'refund(uint64,uint64,byte[],byte[])void',
        args: [0n, 3n * ALGO, Buffer.from(txA1, 'hex'), blob],
        sender: addrA,
        appReferences: [vaultId],
        boxReferences: [vaultBoxRef(vaultId, appId)],
        extraFee: microAlgos(3n * FEE),
        suppressLog: true,
      }),
    ).rejects.toThrow(/proof does not match root/)
    expect(await balanceOf(algorand, addrA)).toEqual(backerBeforeDup)
  })

  test('a pledge without the matching vault credit is rejected', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const { appClient, appId } = await deployCampaign(stack, creator.addr.toString())
    const backerBefore = await balanceOf(algorand, backer.addr.toString())
    const pay = await algorand.createTransaction.payment({
      sender: backer.addr,
      receiver: vaultAddress,
      amount: microAlgos(2n * ALGO),
    })
    const composer = algorand.send.newGroup()
    composer.addAppCallMethodCall({
      appId,
      method: ABIMethod.fromSignature('pledge(pay,byte[])void'),
      args: [pay, new Uint8Array()],
      sender: backer.addr,
    })

    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/credit must follow pledge/)
    expect(await balanceOf(algorand, backer.addr.toString())).toEqual(backerBefore)
    const st = await campaignState(appClient)
    expect(st.n).toEqual(0n)
    expect(st.raised).toEqual(0n)
    expect(await campaignBoxExists(vaultClient, appId)).toEqual(false)
  })

  test('unregistered campaigns cannot touch the vault', async () => {
    oracle = new ClaimTreeOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    // Deploy without registering. The deadline is deliberately far: this test proves the registration gate, and must
    // not depend on suite clock residue from earlier time-travel.
    const { appId } = await deployCampaign(stack, creator.addr.toString(), {
      register: false,
      deadlineOffset: 100_000,
      title: 'Rogue',
      uri: 'ipfs://rogue',
    })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addr = backer.addr.toString()
    const backerBefore = await balanceOf(algorand, addr)

    const pay = await algorand.createTransaction.payment({ sender: addr, receiver: vaultAddress, amount: microAlgos(ALGO) })
    const composer = algorand.send.newGroup()
    composer.addAppCallMethodCall({
      appId,
      method: ABIMethod.fromSignature('pledge(pay,byte[])void'),
      args: [pay, new Uint8Array()],
      sender: addr,
    })
    composer.addAppCallMethodCall({
      appId: vaultId,
      method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
      args: [appId, ALGO],
      sender: addr,
      appReferences: [factoryId],
      boxReferences: [vaultBoxRef(vaultId, appId), registrationBoxRef(factoryId, appId)],
      extraFee: microAlgos(FEE),
    })
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/campaign not registered/)
    expect(await balanceOf(algorand, addr)).toEqual(backerBefore)
    expect(await campaignBoxExists(vaultClient, appId)).toEqual(false)
  })

  test('inner-only vault methods reject top-level callers', async () => {
    oracle = new ClaimTreeOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const { appClient, appId } = await deployCampaign(stack, creator.addr.toString())
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    // One pledge so the box exists: the rejects below then prove caller authority, not box absence.
    await pledge(stack, appClient, appId, backer.addr.toString(), 1n * ALGO, oracle)
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const saddr = stranger.addr.toString()
    const strangerBefore = await balanceOf(algorand, saddr)

    await expect(
      vaultClient.send.call({
        method: 'payBack(uint64,address,uint64)void',
        args: [appId, saddr, 100n],
        sender: saddr,
        appReferences: [appId],
        boxReferences: [vaultBoxRef(vaultId, appId)],
        suppressLog: true,
      }),
    ).rejects.toThrow(/not the campaign app/)
    await expect(
      vaultClient.send.call({ method: 'payClaim(uint64)void', args: [appId], sender: saddr, suppressLog: true }),
    ).rejects.toThrow(/not the campaign app/)
    await expect(
      vaultClient.send.call({
        method: 'settle(uint64,byte[],uint64)void',
        args: [appId, new Uint8Array(32), 0n],
        sender: saddr,
        suppressLog: true,
      }),
    ).rejects.toThrow(/not the campaign app/)
    await expect(
      vaultClient.send.call({ method: 'notifyDelete(uint64)void', args: [appId], sender: saddr, suppressLog: true }),
    ).rejects.toThrow(/not the campaign app/)
    expect(await balanceOf(algorand, saddr)).toEqual(strangerBefore)
  })

  test('successful claim pays the creator exactly, then deletes O(1)', async () => {
    oracle = new ClaimTreeOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const caddr = creator.addr.toString()
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addr = backer.addr.toString()
    const { appClient, appId } = await deployCampaign(stack, caddr, { goal: 3n * ALGO })

    await pledge(stack, appClient, appId, addr, 2n * ALGO, oracle)
    await pledge(stack, appClient, appId, addr, 2n * ALGO, oracle)
    await advanceTime(fixture, 900)

    const balC0 = await balanceOf(algorand, caddr)
    const creatorMinBeforeClaim = await minBalanceOf(algorand, caddr)
    const vaultBalBeforeClaim = await balanceOf(algorand, vaultAddress)
    const vaultMinBeforeClaim = await minBalanceOf(algorand, vaultAddress)
    await claimCampaign(stack, appClient, appId, caddr)
    // 4 ALGO in, 0 out: the creator receives the full live total minus the claim fee.
    expect(await balanceOf(algorand, caddr)).toEqual(balC0 + 4n * ALGO - FEE_CLAIM)
    expect(await minBalanceOf(algorand, caddr)).toEqual(creatorMinBeforeClaim)
    expect(await balanceOf(algorand, vaultAddress)).toEqual(vaultBalBeforeClaim - 4n * ALGO)
    expect(await minBalanceOf(algorand, vaultAddress)).toEqual(vaultMinBeforeClaim)
    const box = await campaignBox(vaultClient, appId)
    expect(box.status).toEqual(3)
    expect(box.paidOut).toEqual(box.paidIn)

    const balC2 = await balanceOf(algorand, caddr)
    await expect(
      appClient.send.call({
        method: 'claim()void',
        args: [],
        sender: caddr,
        appReferences: [vaultId],
        boxReferences: [vaultBoxRef(vaultId, appId)],
        extraFee: microAlgos(2n * FEE),
        suppressLog: true,
      }),
    ).rejects.toThrow(/already claimed/)
    expect(await balanceOf(algorand, caddr)).toEqual(balC2)

    // Unregister and delete in one atomic group: the Factory requires the delete immediately after it.
    const balC1 = await balanceOf(algorand, caddr)
    await deleteCampaign(stack, appId, caddr, { vaultBoxRelease: true })
    expect(await campaignBoxExists(vaultClient, appId)).toEqual(false)
    // Deposit returned; delete releases the box and closes the escrow (the escrow never held funds).
    expect(await balanceOf(algorand, caddr)).toEqual(balC1 + REGISTER_MBR - FEE_UNREGISTER - FEE_DELETE_SETTLED)
  })

  test('failed campaign settles on delete; vault refunds after deletion; finalize sweeps the residual', async () => {
    oracle = new ClaimTreeOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const caddr = creator.addr.toString()
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addrA = backerA.addr.toString()
    const addrB = backerB.addr.toString()
    const { appClient, appId } = await deployCampaign(stack, caddr)

    await pledge(stack, appClient, appId, addrA, 3n * ALGO, oracle)
    const txB = await pledge(stack, appClient, appId, addrB, 1n * ALGO, oracle)
    await advanceTime(fixture, 900)

    // Creator deletes the failed campaign: settle writes root/N + FAILED into the vault box.
    await deleteCampaign(stack, appId, caddr)
    const settled = await campaignBox(vaultClient, appId)
    expect(settled.status).toEqual(2)
    expect(settled.n).toEqual(2n)

    // Either backer refunds straight from the vault (no campaign involved).
    await spendVault(stack, appId, addrB, 1, 1n * ALGO, txB, oracle)
    const afterRefund = await campaignBox(vaultClient, appId)
    expect(afterRefund.paidOut).toEqual(1n * ALGO)

    // Finalize before the window closes is rejected; after it, the 3 ALGO residual goes to the sweeper.
    const balA0 = await balanceOf(algorand, addrA)
    await expect(
      vaultClient.send.call({ method: 'finalize(uint64)void', args: [appId], sender: addrA, extraFee: microAlgos(FEE), suppressLog: true }),
    ).rejects.toThrow(/refund window still open/)
    expect(await balanceOf(algorand, addrA)).toEqual(balA0)
    await advanceTime(fixture, 4_000)
    const balS0 = await balanceOf(algorand, sweeperAddr)
    const vaultMinBeforeFinalize = await minBalanceOf(algorand, vaultAddress)
    await vaultClient.send.call({
      method: 'finalize(uint64)void',
      args: [appId],
      sender: addrA,
      extraFee: microAlgos(FEE),
      suppressLog: true,
    })
    expect(await balanceOf(algorand, sweeperAddr)).toEqual(balS0 + 3n * ALGO)
    expect(await balanceOf(algorand, addrA)).toEqual(balA0 - 2n * FEE) // app call + inner residual payment
    expect(await minBalanceOf(algorand, vaultAddress)).toEqual(vaultMinBeforeFinalize - VAULT_BOX_MBR)
    expect(await campaignBoxExists(vaultClient, appId)).toEqual(false)
  })

  test('pristine and all-cancelled campaigns delete cleanly', async () => {
    oracle = new ClaimTreeOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const caddr = creator.addr.toString()
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addr = backer.addr.toString()

    // Pristine: no box exists, so settle is a no-op; the escrow (holding nothing) closes to the creator.
    const pristine = await deployCampaign(stack, caddr)
    const balP0 = await balanceOf(algorand, caddr)
    await deleteCampaign(stack, pristine.appId, caddr)
    expect(await balanceOf(algorand, caddr)).toEqual(balP0 + REGISTER_MBR - FEE_UNREGISTER - FEE_DELETE_SETTLED)
    expect(await campaignBoxExists(vaultClient, pristine.appId)).toEqual(false)

    // All cancelled: the box settles to FAILED with nothing owed.
    const { appClient, appId } = await deployCampaign(stack, caddr)
    const txid = await pledge(stack, appClient, appId, addr, 1n * ALGO, oracle)
    await spendCampaign(stack, appClient, appId, addr, 0, 1n * ALGO, txid, 'cancelPledge(uint64,uint64,byte[],byte[])void', oracle)
    await deleteCampaign(stack, appId, caddr)
    const box = await campaignBox(vaultClient, appId)
    expect(box.status).toEqual(2)
    expect(box.paidIn).toEqual(box.paidOut)
  })

  test('settleOpen lets a stranger settle a vanished-creator campaign; campaign path then rejects', async () => {
    oracle = new ClaimTreeOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addr = backer.addr.toString()
    const stranger = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const { appClient, appId } = await deployCampaign(stack, creator.addr.toString())

    const txid = await pledge(stack, appClient, appId, addr, 2n * ALGO, oracle)
    await advanceTime(fixture, 900)

    // Anyone settles: reads the live campaign globals, flips the box to FAILED.
    const strangerBefore = await balanceOf(algorand, stranger.addr.toString())
    const vaultMinBeforeSettle = await minBalanceOf(algorand, vaultAddress)
    await vaultClient.send.call({
      method: 'settleOpen(uint64)void',
      args: [appId],
      sender: stranger.addr,
      appReferences: [appId],
      suppressLog: true,
    })
    expect(await balanceOf(algorand, stranger.addr.toString())).toEqual(strangerBefore - FEE)
    expect(await minBalanceOf(algorand, vaultAddress)).toEqual(vaultMinBeforeSettle)
    expect((await campaignBox(vaultClient, appId)).status).toEqual(2)

    // The campaign path now fails at the vault (box not open) - the backer must use vault.refund instead.
    const backerBefore = await balanceOf(algorand, addr)
    const path = oracle.path(0)
    const blob = concatHex([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
    await expect(
      appClient.send.call({
        method: 'refund(uint64,uint64,byte[],byte[])void',
        args: [0n, 2n * ALGO, Buffer.from(txid, 'hex'), blob],
        sender: addr,
        appReferences: [vaultId],
        boxReferences: [vaultBoxRef(vaultId, appId)],
        extraFee: microAlgos(3n * FEE),
        suppressLog: true,
      }),
    ).rejects.toThrow(/campaign is not open/)
    expect(await balanceOf(algorand, addr)).toEqual(backerBefore)
  })

  test('keeps the pledge group funded past N=15 and refunds a wide path', async () => {
    oracle = new ClaimTreeOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addr = backer.addr.toString()
    const { appClient, appId } = await deployCampaign(stack, creator.addr.toString())

    const txids: string[] = []
    for (let i = 0; i < 40; i++) {
      txids.push(await pledge(stack, appClient, appId, addr, 1n * ALGO, oracle))
    }
    const first = txids[0]
    if (first === undefined) throw new Error('no pledge txid')

    // N=40, k=0 has r=5, c=1: the old h*70 budget request left the proof underfunded.
    await spendCampaign(stack, appClient, appId, addr, 0, 1n * ALGO, first, 'cancelPledge(uint64,uint64,byte[],byte[])void', oracle)
    expect((await campaignState(appClient)).raised).toEqual(39n * ALGO)
  })
})
