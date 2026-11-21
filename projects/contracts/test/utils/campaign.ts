import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { addrHex, base32ToBytes, concatHex, selectorOf } from '@kasakame/utils'
import { accountInfo, ALGO, FEE } from '@kasakame/utils/testing'
import { ABIMethod } from 'algosdk'
import { expect } from 'vitest'
import type { ClaimTreeOracle, OraclePath } from './oracle'
import type { ContractStack } from './platform'
import { SIZE_BUDGET } from './size-budget.fixture'
import { campaignBox, campaignBoxExists, campaignState, registrationBoxRef, vaultBoxRef } from './state'

/** Default campaign goal for lifecycle tests. */
export const DEFAULT_GOAL = 10n * ALGO
/** Refund window used by the test vault (seconds): the 30-day contract minimum. */
export const TEST_VAULT_WINDOW = 30n * 24n * 60n * 60n
/** Registration deposit: the minimum balance of the Registry's 32-byte registration box. */
export const REGISTER_MBR = 18_900n
/** Minimum balance parked by one 65-byte vault campaign box. */
export const VAULT_BOX_MBR = 32_100n
/** Base minimum balance of an application account. */
export const APP_BASE = 100_000n
/** Funding sent to a deployed app account in tests. */
export const DEPLOY_FUNDING = 1_000_000n
/** Campaign app MBR from the pinned size budget. */
export const CAMPAIGN_MBR = BigInt(SIZE_BUDGET.campaign.appMbr)
/** ClaimsVault app MBR from the pinned size budget. */
export const VAULT_MBR = BigInt(SIZE_BUDGET.claimsvault.appMbr)
/** Registry app MBR from the pinned size budget. */
export const REGISTRY_MBR = BigInt(SIZE_BUDGET.registry.appMbr)
/** A zero root before settlement. */
export const Z_HEX = '00'.repeat(32)
/** Fee for the campaign create call. */
export const CREATE_FEE = FEE
/** Fees for the register group: the register call plus its payment. */
export const REGISTER_FEES = 2n * FEE
/** Credit call fee plus the extra fee that covers the first-touch registry-check inner call. */
export const FEE_CREDIT = 2n * FEE
/** Pledge group fee excluding the tree-shape OpUp takes: pay + pledge + credit. */
export const PLEDGE_FEES = FEE + FEE + FEE_CREDIT
/** Claim inner app call plus inner payment. */
export const FEE_CLAIM = 3n * FEE
/** Delete with the settle/notify inner call plus escrow close. */
export const FEE_DELETE_SETTLED = 3n * FEE
/** Unregister call plus its inner deposit return. */
export const FEE_UNREGISTER = 2n * FEE
/** The atomic `[unregister, delete]` cleanup group. */
export const CLEANUP_FEES = FEE_UNREGISTER + FEE_DELETE_SETTLED

/** Selectors embedded in the contract bytecode and used by the integration tests. */
export const SELECTORS = {
  payBack: selectorOf('payBack(uint64,address,uint64)void'),
  payClaim: selectorOf('payClaim(uint64)void'),
  settle: selectorOf('settle(uint64,byte[],uint64)void'),
  notifyDelete: selectorOf('notifyDelete(uint64)void'),
  credit: selectorOf('credit(uint64,uint64)void'),
  pledge: selectorOf('pledge(pay,byte[])void'),
  delete: selectorOf('delete()void'),
  isRegistered: selectorOf('isRegistered(uint64)bool'),
} as const

/**
 * Extra fee for a pledge at the current tree size (mirrors the SDK's `pledgeOpUpIterations` and the contract).
 *
 * @param peaks Frontier peak count (popcount of N).
 * @returns The extra fee in microAlgos.
 */
export function pledgeExtraFee(peaks: number): bigint {
  const required = peaks * 240 + 400
  const iterations = Math.max(0, Math.ceil((required + 10 - 1_000) / 700))
  return BigInt(iterations) * FEE
}

/**
 * Extra fee for a spend: the payout inners plus one fee per OpUp take, sizing from the early path-length upper bound
 * with no assumed pre-top-up headroom. That may overpay one take but never underfunds; fee minimality belongs to the
 * SDK.
 *
 * @param path The oracle path for the leaf.
 * @param payoutInners 2 on the campaign path (`payBack` + payment), 1 on the vault path.
 * @returns The extra fee in microAlgos.
 */
export function spendExtraFee(path: OraclePath, payoutInners: 1 | 2): bigint {
  const pathElements = path.siblings.length + path.lower.length + (path.top === null ? 0 : 1)
  const required = pathElements * 250 + 700
  const iterations = Math.max(0, Math.ceil((required + 12) / 670))
  return BigInt(payoutInners + iterations) * FEE
}

/**
 * Total fee for a spend, including the outer call.
 *
 * @param path The oracle path for the leaf.
 * @param payoutInners 2 on the campaign path, 1 on the vault path.
 * @returns The total fee in microAlgos.
 */
export function spendFee(path: OraclePath, payoutInners: 1 | 2): bigint {
  return FEE + spendExtraFee(path, payoutInners)
}

/**
 * Pledge through the real `[pay, campaign.pledge, vault.credit]` group, asserting state, box, and ledger.
 *
 * @param stack The deployed stack.
 * @param appClient The campaign client.
 * @param appId The campaign app id.
 * @param backerAddr The backer's address.
 * @param amount Pledge amount in microAlgos.
 * @param oracle The campaign's reference tree.
 * @returns The confirmed payment TxID (hex).
 */
export async function pledge(
  stack: ContractStack,
  appClient: AppClient,
  appId: bigint,
  backerAddr: string,
  amount: bigint,
  oracle: ClaimTreeOracle,
): Promise<string> {
  const backerBefore = await accountInfo(stack.algorand, backerAddr)
  const vaultBefore = await accountInfo(stack.algorand, stack.vault.address)
  const hadBox = await campaignBoxExists(stack.vault.client, appId)
  const front = oracle.frontier()
  const extraFee = pledgeExtraFee(front.peaks.length)
  const pay = await stack.algorand.createTransaction.payment({
    sender: backerAddr,
    receiver: stack.vault.address,
    amount: microAlgos(amount),
  })
  const composer = stack.algorand.send.newGroup()
  // The payment object is referenced by the pledge call, which pulls it into the group ahead of the call.
  // (Do NOT also pass it via addTransaction - the composer does not dedupe and the group would carry it twice.)
  composer.addAppCallMethodCall({
    appId,
    method: ABIMethod.fromSignature('pledge(pay,byte[])void'),
    args: [pay, concatHex(front.peaks)],
    sender: backerAddr,
    ...(extraFee > 0n ? { extraFee: microAlgos(extraFee) } : {}),
  })
  composer.addAppCallMethodCall({
    appId: stack.vault.appId,
    method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
    args: [appId, amount],
    sender: backerAddr,
    appReferences: [stack.registry.appId],
    boxReferences: [vaultBoxRef(stack.vault.appId, appId), registrationBoxRef(stack.registry.appId, appId)],
    extraFee: microAlgos(FEE),
  })
  const result = await composer.send({ suppressLog: true })
  const payTxid = result.txIds[0]
  if (payTxid === undefined) throw new Error('pledge group returned no payment TxID')
  const txidHex = Buffer.from(base32ToBytes(payTxid)).toString('hex')

  const backerAfter = await accountInfo(stack.algorand, backerAddr)
  const vaultAfter = await accountInfo(stack.algorand, stack.vault.address)
  expect(backerBefore.balance - backerAfter.balance - amount).toEqual(PLEDGE_FEES + extraFee)
  expect(backerAfter.minBalance).toEqual(backerBefore.minBalance)
  expect(vaultAfter.balance - vaultBefore.balance).toEqual(amount)
  expect(vaultAfter.minBalance - vaultBefore.minBalance).toEqual(hadBox ? 0n : VAULT_BOX_MBR)

  const exp = oracle.append(addrHex(backerAddr), amount, txidHex)
  const st = await campaignState(appClient)
  expect(st.n).toEqual(BigInt(exp.n))
  expect(st.root).toEqual(exp.root)
  expect(st.raised).toEqual(BigInt(exp.raised))
  const box = await campaignBox(stack.vault.client, appId)
  expect(box.paidIn - box.paidOut).toEqual(BigInt(exp.raised))
  return txidHex
}

/** The campaign spend entry points. */
export type SpendMethod = 'cancelPledge(uint64,uint64,byte[],byte[])void' | 'refund(uint64,uint64,byte[],byte[])void'

/** Options for the spend helpers. */
export interface SpendOptions {
  /** Pinned number of OpUp inner transactions; asserted when set (LocalNet boundary regression guard). */
  expectedTakes?: number | undefined
}

interface PendingInnerTxn {
  innerTxns?: unknown[]
}

/**
 * Count the OpUp takes from a simulated group. The last top-level call is the campaign or vault spend; its direct inner
 * transactions are the OpUp app creates plus one payout call (`payBack` or the vault payment), so `length - 1` is the
 * take count. The simulator returns the same inners as the send and does not mutate state.
 *
 * @param composer The built spend group.
 * @returns The OpUp take count.
 */
async function simulatedTakeCount(composer: ReturnType<ContractStack['algorand']['newGroup']>): Promise<number> {
  const simulation = await composer.simulate({ allowUnnamedResources: true, skipSignatures: true })
  const last = simulation.simulateResponse.txnGroups[0]?.txnResults.at(-1)?.txnResult as PendingInnerTxn | undefined
  return Math.max(0, (last?.innerTxns?.length ?? 1) - 1)
}

/**
 * Spend a leaf through the campaign (`cancelPledge`/`refund`), asserting state, box, and ledger.
 *
 * @param stack The deployed stack.
 * @param appClient The campaign client.
 * @param appId The campaign app id.
 * @param backerAddr The leaf owner.
 * @param k Leaf position.
 * @param amount Pledged amount committed by the leaf.
 * @param txidHex Pledge payment TxID (hex).
 * @param method Which spend entry point to exercise.
 * @param oracle The campaign's reference tree.
 * @param options Spend options.
 * @returns The OpUp take count.
 */
export async function spendCampaign(
  stack: ContractStack,
  appClient: AppClient,
  appId: bigint,
  backerAddr: string,
  k: number,
  amount: bigint,
  txidHex: string,
  method: SpendMethod,
  oracle: ClaimTreeOracle,
  options: SpendOptions = {},
): Promise<number> {
  const backerBefore = await accountInfo(stack.algorand, backerAddr)
  const vaultBefore = await accountInfo(stack.algorand, stack.vault.address)
  const path = oracle.path(k)
  const blob = concatHex([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
  const composer = stack.algorand.newGroup()
  composer.addAppCallMethodCall({
    appId,
    method: ABIMethod.fromSignature(method),
    args: [BigInt(k), amount, Buffer.from(txidHex, 'hex'), blob],
    sender: backerAddr,
    appReferences: [stack.vault.appId],
    boxReferences: [vaultBoxRef(stack.vault.appId, appId)],
    extraFee: microAlgos(spendExtraFee(path, 2)),
  })
  const takes = await simulatedTakeCount(composer)
  await composer.send({ suppressLog: true })
  if (options.expectedTakes !== undefined) expect(takes).toEqual(options.expectedTakes)
  const backerAfter = await accountInfo(stack.algorand, backerAddr)
  const vaultAfter = await accountInfo(stack.algorand, stack.vault.address)
  expect(backerAfter.balance - backerBefore.balance).toEqual(amount - spendFee(path, 2))
  expect(backerAfter.minBalance).toEqual(backerBefore.minBalance)
  expect(vaultBefore.balance - vaultAfter.balance).toEqual(amount)
  expect(vaultAfter.minBalance).toEqual(vaultBefore.minBalance)

  const exp = oracle.spend(k, amount)
  const st = await campaignState(appClient)
  expect(st.n).toEqual(BigInt(exp.n))
  expect(st.root).toEqual(exp.root)
  expect(st.raised).toEqual(BigInt(exp.raised))
  const box = await campaignBox(stack.vault.client, appId)
  expect(box.paidOut).toEqual(box.paidIn - BigInt(exp.raised))
  return takes
}

/**
 * Refund straight from the vault after settlement, asserting state, box, and ledger.
 *
 * @param stack The deployed stack.
 * @param appId The campaign app id.
 * @param backerAddr The leaf owner.
 * @param k Leaf position.
 * @param amount Pledged amount committed by the leaf.
 * @param txidHex Pledge payment TxID (hex).
 * @param oracle The campaign's reference tree.
 * @param options Spend options.
 * @returns The OpUp take count.
 */
export async function spendVault(
  stack: ContractStack,
  appId: bigint,
  backerAddr: string,
  k: number,
  amount: bigint,
  txidHex: string,
  oracle: ClaimTreeOracle,
  options: SpendOptions = {},
): Promise<number> {
  const backerBefore = await accountInfo(stack.algorand, backerAddr)
  const vaultBefore = await accountInfo(stack.algorand, stack.vault.address)
  const path = oracle.path(k)
  const blob = concatHex([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
  const composer = stack.algorand.newGroup()
  composer.addAppCallMethodCall({
    appId: stack.vault.appId,
    method: ABIMethod.fromSignature('refund(uint64,uint64,uint64,byte[],byte[])void'),
    args: [appId, BigInt(k), amount, Buffer.from(txidHex, 'hex'), blob],
    sender: backerAddr,
    boxReferences: [vaultBoxRef(stack.vault.appId, appId)],
    extraFee: microAlgos(spendExtraFee(path, 1)),
  })
  const takes = await simulatedTakeCount(composer)
  await composer.send({ suppressLog: true })
  if (options.expectedTakes !== undefined) expect(takes).toEqual(options.expectedTakes)
  const backerAfter = await accountInfo(stack.algorand, backerAddr)
  const vaultAfter = await accountInfo(stack.algorand, stack.vault.address)
  expect(backerAfter.balance - backerBefore.balance).toEqual(amount - spendFee(path, 1))
  expect(backerAfter.minBalance).toEqual(backerBefore.minBalance)
  expect(vaultBefore.balance - vaultAfter.balance).toEqual(amount)
  expect(vaultAfter.minBalance).toEqual(vaultBefore.minBalance)

  const exp = oracle.spend(k, amount)
  const box = await campaignBox(stack.vault.client, appId)
  expect(box.root).toEqual(exp.root)
  expect(box.paidOut).toEqual(box.paidIn - BigInt(exp.raised))
  return takes
}

/**
 * Claim through the campaign (inner `payClaim` app call + payment).
 *
 * @param stack The deployed stack.
 * @param appClient The campaign client.
 * @param appId The campaign app id.
 * @param creatorAddr The campaign creator.
 */
export async function claimCampaign(stack: ContractStack, appClient: AppClient, appId: bigint, creatorAddr: string): Promise<void> {
  await appClient.send.call({
    method: 'claim()void',
    args: [],
    sender: creatorAddr,
    appReferences: [stack.vault.appId],
    boxReferences: [vaultBoxRef(stack.vault.appId, appId)],
    extraFee: microAlgos(2n * FEE),
    suppressLog: true,
  })
}
