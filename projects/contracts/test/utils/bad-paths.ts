import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { FEE_MICRO_ALGOS, MICRO_ALGOS_PER_ALGO, REGISTER_DEPOSIT_MICRO_ALGOS, SECONDS_PER_DAY } from '@kasakame/constants'
import { advanceTime, appIdBytes, concatHex, registrationBoxRef, vaultBoxRef } from '@kasakame/utils/testing'
import type { Account } from 'algosdk'
import { ABIMethod, OnApplicationComplete } from 'algosdk'
import { pledge, spendExtraFee } from './campaign'
import { ClaimTreeOracle, type OraclePath } from './oracle'
import { deployCampaign, type ContractStack, type DeployCampaignOptions } from './platform'

type Composer = ReturnType<ContractStack['algorand']['send']['newGroup']>

/** A campaign deployed for a bad-path scenario, with its creator and oracle. */
export interface CampaignFixture {
  appClient: AppClient
  appId: bigint
  creator: Account
  oracle: ClaimTreeOracle
}

/** Pledge payment overrides for {@link buildPledgeGroup}. */
export interface PaymentOptions {
  amount: bigint
  sender?: string
  receiver?: string
  closeRemainderTo?: string
  rekeyTo?: string
  /** Account that pays the whole group's fees (for the close-remainder case, where the payer is drained). */
  feePayer?: string
}

/** Credit overrides for {@link buildPledgeGroup}. */
export interface CreditOptions {
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

/**
 * Deploy a campaign with a fresh creator and its own oracle.
 *
 * @param fixture The Algorand fixture.
 * @param stack The deployed stack.
 * @param options Campaign deployment options.
 * @returns The campaign fixture.
 */
export async function createBadPathCampaign(
  fixture: AlgorandFixture,
  stack: ContractStack,
  options: DeployCampaignOptions = {},
): Promise<CampaignFixture> {
  const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
  const campaign = await deployCampaign(stack, creator.addr.toString(), options)
  return { ...campaign, creator, oracle: new ClaimTreeOracle('bad-path-') }
}

/**
 * Submit a campaign spend without asserting state or ledger, so a rejected proof can be followed by a retry.
 *
 * @param stack The deployed stack.
 * @param campaign The campaign fixture.
 * @param sender The account submitting the call.
 * @param k Leaf position.
 * @param amount Amount committed by the leaf.
 * @param txidHex Pledge payment TxID (hex).
 * @param path The path being submitted.
 * @param method The spend method.
 * @returns The send promise.
 */
export async function attemptCampaignSpend(
  stack: ContractStack,
  campaign: CampaignFixture,
  sender: Account,
  k: number,
  amount: bigint,
  txidHex: string,
  path: OraclePath,
  method: 'cancelPledge(uint64,uint64,byte[],byte[])void' | 'refund(uint64,uint64,byte[],byte[])void',
): Promise<unknown> {
  const blob = concatHex([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
  return campaign.appClient.send.call({
    method,
    args: [BigInt(k), amount, Buffer.from(txidHex, 'hex'), blob],
    sender: sender.addr,
    appReferences: [stack.vault.appId],
    boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
    extraFee: microAlgos(spendExtraFee(path, 2)),
    suppressLog: true,
  })
}

/**
 * Build the `[pay, pledge, credit]` group with raw overrides for each guard case.
 *
 * @param stack The deployed stack.
 * @param campaign The campaign fixture.
 * @param callerAddr The pledge sender.
 * @param payment Payment overrides.
 * @param frontier Frontier peaks.
 * @param credit Credit overrides, or false to omit the credit.
 * @returns The composer holding the group.
 */
export async function buildPledgeGroup(
  stack: ContractStack,
  campaign: CampaignFixture,
  callerAddr: string,
  payment: PaymentOptions,
  frontier: string[],
  credit: CreditOptions | boolean = {},
): Promise<Composer> {
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
      staticFee: microAlgos(groupSize * FEE_MICRO_ALGOS),
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
      // Repeated credits must differ or algod rejects the group as duplicates before the vault's final-txn guard runs.
      const creditAmount = (options.amount ?? payment.amount) + (i === 0 ? 0n : 1n)
      const creditParams = {
        appId: target,
        sender: callerAddr,
        appReferences: target === stack.vault.appId ? [stack.registry.appId] : [stack.registry.appId, stack.vault.appId],
        boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId), registrationBoxRef(stack.registry.appId, campaign.appId)],
        ...(defaultFee ? { extraFee: microAlgos(FEE_MICRO_ALGOS) } : { staticFee: microAlgos(0n) }),
      }
      if (options.rawSelector !== undefined) {
        composer.addAppCall({
          ...creditParams,
          ...(options.onComplete === undefined ? {} : { onComplete: options.onComplete }),
          args: [options.rawSelector, appIdBytes(campaign.appId), appIdBytes(creditAmount)],
        })
      } else {
        composer.addAppCallMethodCall({
          ...creditParams,
          method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
          args: [campaign.appId, creditAmount],
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

/**
 * Deploy a below-goal campaign, pledge once, and advance past the deadline.
 *
 * @param fixture The Algorand fixture.
 * @param stack The deployed stack.
 * @param amount The pledge amount.
 * @param goal The campaign goal.
 * @returns The campaign, backer, and pledge TxID.
 */
export async function failedBadPathCampaign(
  fixture: AlgorandFixture,
  stack: ContractStack,
  amount = 1n * MICRO_ALGOS_PER_ALGO,
  goal = 2n * MICRO_ALGOS_PER_ALGO,
): Promise<{ campaign: CampaignFixture; backer: Account; txid: string }> {
  const campaign = await createBadPathCampaign(fixture, stack, { goal })
  const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
  const txid = await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), amount, campaign.oracle)
  await advanceTime(fixture, SECONDS_PER_DAY)
  return { campaign, backer, txid }
}

/**
 * Send the vault's refund call directly, bypassing the campaign route.
 *
 * @param stack The deployed stack.
 * @param campaign The campaign fixture.
 * @param backer The refunding account.
 * @param k Leaf position.
 * @param amount Amount committed by the leaf.
 * @param txid Pledge payment TxID (hex).
 * @param path The path being submitted.
 */
export async function refundFromVault(
  stack: ContractStack,
  campaign: CampaignFixture,
  backer: Account,
  k: number,
  amount: bigint,
  txid: string,
  path: OraclePath,
): Promise<void> {
  const blob = concatHex([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
  await stack.vault.client.send.call({
    method: 'refund(uint64,uint64,uint64,byte[],byte[])void',
    args: [campaign.appId, BigInt(k), amount, Buffer.from(txid, 'hex'), blob],
    sender: backer.addr,
    boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
    extraFee: microAlgos(FEE_MICRO_ALGOS + 2n * FEE_MICRO_ALGOS),
    suppressLog: true,
  })
}

/**
 * Call the vault's permissionless `settleOpen` directly.
 *
 * @param stack The deployed stack.
 * @param appId The campaign app id.
 * @param sender The caller.
 */
export async function settleOpen(stack: ContractStack, appId: bigint, sender: string): Promise<void> {
  await stack.vault.client.send.call({
    method: 'settleOpen(uint64)void',
    args: [appId],
    sender,
    appReferences: [appId],
    suppressLog: true,
  })
}

/**
 * Build a lone campaign delete, without the Registry unregister.
 *
 * @param stack The deployed stack.
 * @param campaign The campaign fixture.
 * @param sender The delete sender.
 * @returns The composer holding the delete.
 */
export function buildRawDeleteGroup(stack: ContractStack, campaign: CampaignFixture, sender: Account): Composer {
  const composer = stack.algorand.send.newGroup()
  composer.addAppCallMethodCall({
    appId: campaign.appId,
    method: ABIMethod.fromSignature('delete()void'),
    args: [],
    sender: sender.addr,
    onComplete: OnApplicationComplete.DeleteApplicationOC,
    appReferences: [stack.vault.appId],
    boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId)],
    extraFee: microAlgos(2n * FEE_MICRO_ALGOS),
  })
  return composer
}

/** Senders and box declaration for {@link buildUnregisterDeleteGroup}. */
export interface UnregisterDeleteOptions {
  unregisterSender: Account
  deleteSender: Account
  /** Declare the vault box on the delete. Defaults to true. */
  declareVaultBox?: boolean
}

/**
 * Build the `[unregister, delete]` cleanup group.
 *
 * @param stack The deployed stack.
 * @param appId The campaign app id.
 * @param options Senders and box declaration.
 * @returns The composer holding the cleanup group.
 */
export function buildUnregisterDeleteGroup(stack: ContractStack, appId: bigint, options: UnregisterDeleteOptions): Composer {
  const composer = stack.algorand.send.newGroup()
  composer.addAppCallMethodCall({
    appId: stack.registry.appId,
    method: ABIMethod.fromSignature('unregister(uint64)void'),
    args: [appId],
    sender: options.unregisterSender.addr,
    appReferences: [appId],
    extraFee: microAlgos(FEE_MICRO_ALGOS),
  })
  composer.addAppCallMethodCall({
    appId,
    method: ABIMethod.fromSignature('delete()void'),
    args: [],
    sender: options.deleteSender.addr,
    onComplete: OnApplicationComplete.DeleteApplicationOC,
    appReferences: [stack.vault.appId],
    boxReferences: options.declareVaultBox === false ? [] : [vaultBoxRef(stack.vault.appId, appId)],
    extraFee: microAlgos(2n * FEE_MICRO_ALGOS),
  })
  return composer
}

/**
 * Build the `[pay, credit]` group with no preceding pledge.
 *
 * @param stack The deployed stack.
 * @param campaign The campaign fixture.
 * @param caller The payer and credit sender.
 * @param amount The credit amount.
 * @returns The composer holding the group.
 */
export async function buildCreditGroup(
  stack: ContractStack,
  campaign: CampaignFixture,
  caller: Account,
  amount: bigint,
): Promise<Composer> {
  const pay = await stack.algorand.createTransaction.payment({
    sender: caller.addr,
    receiver: stack.vault.address,
    amount: microAlgos(amount),
  })
  const composer = stack.algorand.send.newGroup()
  composer.addTransaction(pay)
  composer.addAppCallMethodCall({
    appId: stack.vault.appId,
    method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
    args: [campaign.appId, amount],
    sender: caller.addr,
    appReferences: [stack.registry.appId],
    boxReferences: [vaultBoxRef(stack.vault.appId, campaign.appId), registrationBoxRef(stack.registry.appId, campaign.appId)],
    extraFee: microAlgos(FEE_MICRO_ALGOS),
  })
  return composer
}

/** Register overrides for {@link buildRegisterGroup}. */
export interface RegisterAttemptOptions {
  /** App-call sender, which must be the campaign creator. */
  sender: Account
  /** Payment sender; defaults to the app-call sender. */
  paymentSender?: Account
  amount?: bigint
  receiver?: string
  rekeyTo?: string
  trailing?: boolean
}

/**
 * Build the `[pay, register]` group with raw deposit overrides.
 *
 * @param stack The deployed stack.
 * @param appId The campaign app id being registered.
 * @param options Register overrides.
 * @returns The composer holding the group.
 */
export async function buildRegisterGroup(stack: ContractStack, appId: bigint, options: RegisterAttemptOptions): Promise<Composer> {
  const sender = options.sender.addr.toString()
  const paySender = (options.paymentSender ?? options.sender).addr.toString()
  const pay = await stack.algorand.createTransaction.payment({
    sender: paySender,
    receiver: options.receiver ?? stack.registry.address,
    amount: microAlgos(options.amount ?? REGISTER_DEPOSIT_MICRO_ALGOS),
    ...(options.rekeyTo === undefined ? {} : { rekeyTo: options.rekeyTo }),
  })
  const composer = stack.algorand.send.newGroup()
  composer.addAppCallMethodCall({
    appId: stack.registry.appId,
    method: ABIMethod.fromSignature('register(uint64,pay)void'),
    args: [appId, pay],
    sender,
    appReferences: [appId],
  })
  if (options.trailing === true) {
    composer.addPayment({ sender, receiver: sender, amount: microAlgos(0n) })
  }
  return composer
}
