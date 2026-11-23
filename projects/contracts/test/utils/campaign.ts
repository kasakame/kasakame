import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import {
  FEE_MICRO_ALGOS,
  MICRO_ALGOS_PER_ALGO,
  OPUP_AVAILABLE_BUDGET,
  OPUP_BUDGET_PER_ITERATION,
  OPUP_ITERATION_SLACK,
  OPUP_SPEND_NET_BUDGET,
  PLEDGE_BASE_COST,
  PLEDGE_GROUP_FEE_MICRO_ALGOS,
  PLEDGE_PEAK_COST,
  SPEND_BASE_COST,
  SPEND_ELEMENT_COST,
  SPEND_TOP_UP_OVERHEAD,
  VAULT_BOX_MBR_MICRO_ALGOS,
} from '@kasakame/constants'
import { accountInfo, addrHex, base32ToBytes, concatHex, selectorOf } from '@kasakame/utils/testing'
import { ABIMethod } from 'algosdk'
import { expect } from 'vitest'
import { CONTRACT_SIZES } from './contract-sizes'
import type { ClaimTreeOracle, OraclePath } from './oracle'
import type { ContractStack } from './platform'
import { campaignBox, campaignBoxExists, campaignState, registrationBoxRef, vaultBoxRef } from './state'

/** Default campaign goal for lifecycle tests. */
export const DEFAULT_GOAL = 10n * MICRO_ALGOS_PER_ALGO
/** Campaign app MBR from the pinned size budget. */
export const CAMPAIGN_MBR = BigInt(CONTRACT_SIZES.campaign.appMbr)
/** ClaimsVault app MBR from the pinned size budget. */
export const VAULT_MBR = BigInt(CONTRACT_SIZES.claimsvault.appMbr)
/** Registry app MBR from the pinned size budget. */
export const REGISTRY_MBR = BigInt(CONTRACT_SIZES.registry.appMbr)

/** Selectors embedded in the contract bytecode and used by the integration tests. */
export const SELECTORS = {
  payBack: selectorOf('payBack(uint64,address,uint64)void'),
  payClaim: selectorOf('payClaim(uint64)void'),
  settle: selectorOf('settle(uint64,byte[],uint64)void'),
  notifyDelete: selectorOf('notifyDelete(uint64)void'),
  credit: selectorOf('credit(uint64,uint64)void'),
  pledge: selectorOf('pledge(pay,byte[])void'),
  cancelPledge: selectorOf('cancelPledge(uint64,uint64,byte[],byte[])void'),
  refund: selectorOf('refund(uint64,uint64,byte[],byte[])void'),
  vaultRefund: selectorOf('refund(uint64,uint64,uint64,byte[],byte[])void'),
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
  const required = peaks * PLEDGE_PEAK_COST + PLEDGE_BASE_COST
  const iterations = Math.max(0, Math.ceil((required + OPUP_ITERATION_SLACK - OPUP_AVAILABLE_BUDGET) / OPUP_BUDGET_PER_ITERATION))
  return BigInt(iterations) * FEE_MICRO_ALGOS
}

/**
 * Extra fee for a spend: payout inners plus OpUp takes sized from the path-length bound, never underfunding.
 *
 * @param path The oracle path for the leaf.
 * @param payoutInners 2 on the campaign path (`payBack` + payment), 1 on the vault path.
 * @returns The extra fee in microAlgos.
 */
export function spendExtraFee(path: OraclePath, payoutInners: 1 | 2): bigint {
  const pathElements = path.siblings.length + path.lower.length + (path.top === null ? 0 : 1)
  const required = pathElements * SPEND_ELEMENT_COST + SPEND_BASE_COST
  const iterations = Math.max(0, Math.ceil((required + SPEND_TOP_UP_OVERHEAD) / OPUP_SPEND_NET_BUDGET))
  return BigInt(payoutInners + iterations) * FEE_MICRO_ALGOS
}

/**
 * Total fee for a spend, including the outer call.
 *
 * @param path The oracle path for the leaf.
 * @param payoutInners 2 on the campaign path, 1 on the vault path.
 * @returns The total fee in microAlgos.
 */
export function spendFee(path: OraclePath, payoutInners: 1 | 2): bigint {
  return FEE_MICRO_ALGOS + spendExtraFee(path, payoutInners)
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
  // Passing `pay` as a method arg pulls it into the group; never also addTransaction it (the composer does not dedupe).
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
    extraFee: microAlgos(FEE_MICRO_ALGOS),
  })
  const result = await composer.send({ suppressLog: true })
  const payTxid = result.txIds[0]
  if (payTxid === undefined) throw new Error('pledge group returned no payment TxID')
  const txidHex = Buffer.from(base32ToBytes(payTxid)).toString('hex')

  const backerAfter = await accountInfo(stack.algorand, backerAddr)
  const vaultAfter = await accountInfo(stack.algorand, stack.vault.address)
  expect(backerBefore.balance - backerAfter.balance - amount).toEqual(PLEDGE_GROUP_FEE_MICRO_ALGOS + extraFee)
  expect(backerAfter.minBalance).toEqual(backerBefore.minBalance)
  expect(vaultAfter.balance - vaultBefore.balance).toEqual(amount)
  expect(vaultAfter.minBalance - vaultBefore.minBalance).toEqual(hadBox ? 0n : VAULT_BOX_MBR_MICRO_ALGOS)

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
 * Counts OpUp takes from a simulated group as the last call's inners minus the payout; the simulator does not mutate state.
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
    extraFee: microAlgos(2n * FEE_MICRO_ALGOS),
    suppressLog: true,
  })
}
