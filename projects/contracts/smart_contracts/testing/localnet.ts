import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import type { Account } from 'algosdk'
import { ABIMethod, OnApplicationComplete, decodeAddress } from 'algosdk'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from 'vitest'
import { programHash } from '../program-hash'
import { SIZE_BUDGET } from '../size-budget.fixture'

/**
 * Shared LocalNet helpers for the contract integration suites: fixture deployment, the claim-tree reference oracle,
 * ledger assertions, box reads, and the fee formulas the contracts actually request.
 *
 * The three `contract.integration.test.ts` files use this module so a formula or ledger check changes in one place.
 * It is test-only and not published. The cross-project harness is tracked separately (#164).
 */

/** MicroAlgos in one ALGO. */
export const ALGO = 1_000_000n
/** The minimum transaction fee. */
export const FEE = 1_000n
/** Default campaign goal for lifecycle tests. */
export const DEFAULT_GOAL = 10n * ALGO
/** Refund window used by the test vault (seconds). */
export const TEST_VAULT_WINDOW = 3_600n
/** Registration deposit: the minimum balance of the Factory's 32-byte registration box. */
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
/** Factory app MBR from the pinned size budget. */
export const FACTORY_MBR = BigInt(SIZE_BUDGET.factory.appMbr)
/** A zero root before settlement. */
export const Z_HEX = '00'.repeat(32)
/** Fee for the campaign create call. */
export const CREATE_FEE = FEE
/** Fees for the register group: the register call plus its payment. */
export const REGISTER_FEES = 2n * FEE
/** Credit call fee plus the extra fee that covers the first-touch factory-check inner call. */
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

/**
 * @param signature An ARC-4 method signature.
 * @returns The 4-byte selector as hex.
 */
export function selectorOf(signature: string): string {
  return createHash('sha512-256').update(signature).digest('hex').slice(0, 8)
}

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

/** The oracle's view of a campaign tree. */
export interface OracleState {
  n: number
  root: string
  raised: number
}

/** A leaf's refund path as the oracle emits it. */
export interface OraclePath {
  siblings: string[]
  top: string | null
  lower: string[]
}

/** The frontier peaks before an append. */
export interface OracleFrontier {
  peaks: string[]
}

/**
 * One reference-oracle tree (`smart_contracts/oracle.py`) with its own state file, so campaigns stay independent.
 */
export class ClaimTreeOracle {
  private readonly file: string

  constructor(prefix = 'claimtree-it-') {
    this.file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'state.json')
    this.cmd('init')
  }

  private cmd(command: string, ...args: string[]): unknown {
    const out = execFileSync('python3', [path.resolve(__dirname, '../oracle.py'), this.file, command, ...args], {
      encoding: 'utf8',
    })
    return JSON.parse(out) as unknown
  }

  /** @returns The current frontier peaks. */
  frontier(): OracleFrontier {
    return this.cmd('frontier') as OracleFrontier
  }

  /**
   * Append a leaf.
   *
   * @param backer Backer address (hex public key).
   * @param amount Pledge amount in microAlgos.
   * @param txidHex Confirmed payment TxID (hex).
   * @returns The resulting tree state.
   */
  append(backer: string, amount: bigint, txidHex: string): OracleState {
    return this.cmd('append', backer, amount.toString(), txidHex) as OracleState
  }

  /**
   * @param k Leaf position.
   * @returns The refund path for the leaf.
   */
  path(k: number): OraclePath {
    return this.cmd('path', k.toString()) as OraclePath
  }

  /**
   * Mark a leaf spent.
   *
   * @param k Leaf position.
   * @param amount Amount spent in microAlgos.
   * @returns The resulting tree state.
   */
  spend(k: number, amount: bigint): OracleState {
    return this.cmd('null', k.toString(), amount.toString()) as OracleState
  }

  /** @returns The current tree state. */
  state(): OracleState {
    return this.cmd('state') as OracleState
  }
}

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
 * Extra fee for a spend: the payout inners plus one fee per OpUp take, assuming no budget survives the method
 * prelude. That is an upper bound on the takes the contract requests (the real headroom shrinks with the path size),
 * so the group is always funded; fee minimality belongs to the SDK.
 *
 * @param path The oracle path for the leaf.
 * @param payoutInners 2 on the campaign path (`payBack` + payment), 1 on the vault path.
 * @returns The extra fee in microAlgos.
 */
export function spendExtraFee(path: OraclePath, payoutInners: 1 | 2): bigint {
  const required = path.siblings.length * 250 + path.lower.length * 250 + (path.top === null ? 0 : 100) + 700
  const iterations = Math.max(0, Math.ceil((required + 10) / 700))
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

/** An account's spendable balance and its minimum balance. */
export interface AccountAmounts {
  balance: bigint
  minBalance: bigint
}

/**
 * Read an account's balance and minimum balance.
 *
 * @param algorand The LocalNet client.
 * @param address The account address.
 * @returns The account amounts.
 */
export async function accountInfo(algorand: AlgorandClient, address: string): Promise<AccountAmounts> {
  const info = await algorand.account.getInformation(address)
  return { balance: info.balance.microAlgo, minBalance: info.minBalance.microAlgo }
}

/**
 * @param algorand The LocalNet client.
 * @param address The account address.
 * @returns Its spendable balance.
 */
export async function balanceOf(algorand: AlgorandClient, address: string): Promise<bigint> {
  return (await accountInfo(algorand, address)).balance
}

/**
 * @param algorand The LocalNet client.
 * @param address The account address.
 * @returns Its minimum balance.
 */
export async function minBalanceOf(algorand: AlgorandClient, address: string): Promise<bigint> {
  return (await accountInfo(algorand, address)).minBalance
}

/**
 * Advance the dev-mode chain clock by producing one self-payment, then reset the offset.
 *
 * @param fixture The Algorand fixture (for the funded test account).
 * @param seconds Seconds to jump forward.
 */
export async function advanceTime(fixture: AlgorandFixture, seconds: number): Promise<void> {
  const algorand = fixture.context.algorand
  const algod = algorand.client.algod
  try {
    await algod.setBlockOffsetTimestamp(seconds).do()
    await algorand.send.payment({
      sender: fixture.context.testAccount.addr,
      receiver: fixture.context.testAccount.addr,
      amount: (0.001).algo(),
      suppressLog: true,
    })
  } finally {
    await algod.setBlockOffsetTimestamp(0).do()
  }
}

/**
 * @param addr An address.
 * @returns Its 32-byte public key as hex.
 */
export function addrHex(addr: string): string {
  return Buffer.from(decodeAddress(addr).publicKey).toString('hex')
}

/**
 * Decode an unpadded RFC 4648 base32 string (confirmed TxIDs) to bytes.
 *
 * @param input Unpadded base32 input.
 * @returns The decoded bytes.
 */
export function base32ToBytes(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of input) {
    value = (value << 5) | alphabet.indexOf(char)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return new Uint8Array(out)
}

/**
 * @param hexes Hex strings.
 * @returns The concatenated bytes.
 */
export function concatHex(hexes: string[]): Uint8Array {
  return new Uint8Array(Buffer.concat(hexes.map((h) => Buffer.from(h, 'hex'))))
}

/**
 * @param appId An application id.
 * @returns Its 8-byte big-endian encoding.
 */
export function appIdBytes(appId: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(appId)
  return buf
}

/**
 * @param vaultId The vault app id.
 * @param appId The campaign app id.
 * @returns The vault's campaign-box reference.
 */
export function vaultBoxRef(vaultId: bigint, appId: bigint): { appId: bigint; name: Uint8Array } {
  return { appId: vaultId, name: new Uint8Array(Buffer.concat([Buffer.from('c'), appIdBytes(appId)])) }
}

/**
 * @param factoryId The Factory app id.
 * @param appId The campaign app id.
 * @returns The registration-box reference.
 */
export function registrationBoxRef(factoryId: bigint, appId: bigint): { appId: bigint; name: Uint8Array } {
  return { appId: factoryId, name: new Uint8Array(Buffer.concat([Buffer.from('r'), appIdBytes(appId)])) }
}

/** The vault's per-campaign box. */
export interface CampaignBox {
  paidIn: bigint
  paidOut: bigint
  root: string
  n: bigint
  status: number
  settledAt: bigint
}

/**
 * Read the vault's campaign box.
 *
 * @param vaultClient The vault client.
 * @param appId The campaign app id.
 * @returns The decoded box.
 */
export async function campaignBox(vaultClient: AppClient, appId: bigint): Promise<CampaignBox> {
  const raw = Buffer.from((await vaultClient.state.box.getMapValue('campaignBox', appId)) as Uint8Array)
  if (raw.length !== 65) throw new Error(`campaign box ${appId.toString()} has ${raw.length.toString()} bytes, expected 65`)
  return {
    paidIn: raw.subarray(0, 8).readBigUInt64BE(),
    paidOut: raw.subarray(8, 16).readBigUInt64BE(),
    root: raw.subarray(16, 48).toString('hex'),
    n: raw.subarray(48, 56).readBigUInt64BE(),
    status: raw[56] ?? 0,
    settledAt: raw.subarray(57, 65).readBigUInt64BE(),
  }
}

/**
 * Whether the vault's campaign box exists.
 *
 * @param vaultClient The vault client.
 * @param appId The campaign app id.
 * @returns True when the box is present.
 */
export async function campaignBoxExists(vaultClient: AppClient, appId: bigint): Promise<boolean> {
  try {
    await vaultClient.state.box.getMapValue('campaignBox', appId)
    return true
  } catch {
    return false
  }
}

/** The campaign globals the tests assert against the oracle. */
export interface CampaignState {
  n: bigint
  root: string
  raised: bigint
  status: bigint
}

/**
 * @param appClient The campaign client.
 * @returns The live campaign globals.
 */
export async function campaignState(appClient: AppClient): Promise<CampaignState> {
  const n = (await appClient.state.global.getValue('n')) as bigint
  const raised = (await appClient.state.global.getValue('raised')) as bigint
  const status = (await appClient.state.global.getValue('status')) as bigint
  const root = (await appClient.state.global.getValue('root')) as Uint8Array
  return { n, root: Buffer.from(root).toString('hex'), raised, status }
}

/** The three ARC-56 specs the integration suites deploy. */
export interface ContractSpecs {
  campaign: Arc56Contract
  factory: Arc56Contract
  vault: Arc56Contract
}

function readSpec(relativePath: string): Arc56Contract {
  const file = path.resolve(__dirname, '../artifacts', relativePath)
  if (!fs.existsSync(file)) throw new Error(`${relativePath} not found; run \`npm run build\` first.`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Arc56Contract
}

/** @returns The compiled ARC-56 specs (requires `npm run build`). */
export function loadContractSpecs(): ContractSpecs {
  return {
    campaign: readSpec('campaign/Campaign.arc56.json'),
    factory: readSpec('factory/Factory.arc56.json'),
    vault: readSpec('claimsvault/ClaimsVault.arc56.json'),
  }
}

function specProgramHash(spec: Arc56Contract, name: string): Uint8Array {
  if (spec.byteCode === undefined) throw new Error(`${name} has no byteCode; run \`npm run build\` first.`)
  return programHash(Buffer.from(spec.byteCode.approval, 'base64'), Buffer.from(spec.byteCode.clear, 'base64'))
}

/** A deployed application. */
export interface DeployedApp {
  client: AppClient
  appId: bigint
  address: string
}

/** A deployed Factory + bound ClaimsVault, plus the platform accounts. */
export interface ContractStack {
  algorand: AlgorandClient
  specs: ContractSpecs
  owner: Account
  sweeper: Account
  ownerAddress: string
  sweeperAddress: string
  factory: DeployedApp
  vault: DeployedApp
}

/** Options for {@link deployStack}. */
export interface DeployStackOptions {
  /** ALGO funded to the platform owner. Defaults to 50. */
  ownerAlgo?: number
  /** Refund window for the test vault. Defaults to {@link TEST_VAULT_WINDOW}. */
  vaultWindowSeconds?: bigint
  /** ALGO funded to the vault app account. Defaults to {@link DEPLOY_FUNDING}; use 0 to assert a bare vault. */
  fundVault?: bigint
  /** Configure the official campaign hash. Defaults to true; Factory tests set it per deployed program. */
  configureCampaignHash?: boolean
}

async function deployFactory(algorand: AlgorandClient, spec: Arc56Contract, ownerAddr: string): Promise<DeployedApp> {
  const factory = new AppFactory({ appSpec: spec, algorand, defaultSender: ownerAddr })
  const { appClient } = await factory.send.create({ method: 'create()void', args: [], sender: ownerAddr, suppressLog: true })
  await algorand.send.payment({ sender: ownerAddr, receiver: appClient.appAddress, amount: microAlgos(DEPLOY_FUNDING), suppressLog: true })
  return { client: appClient, appId: appClient.appId, address: appClient.appAddress.toString() }
}

async function deployVault(
  algorand: AlgorandClient,
  spec: Arc56Contract,
  options: { factoryId: bigint; ownerAddr: string; sweeperAddr: string; windowSeconds: bigint; funding: bigint },
): Promise<DeployedApp> {
  const factory = new AppFactory({ appSpec: spec, algorand, defaultSender: options.ownerAddr })
  const { appClient } = await factory.send.create({
    method: 'create(uint64,address,uint64)void',
    args: [options.factoryId, options.sweeperAddr, options.windowSeconds],
    sender: options.ownerAddr,
    appReferences: [options.factoryId],
    suppressLog: true,
  })
  if (options.funding > 0n) {
    await algorand.send.payment({
      sender: options.ownerAddr,
      receiver: appClient.appAddress,
      amount: microAlgos(options.funding),
      suppressLog: true,
    })
  }
  return { client: appClient, appId: appClient.appId, address: appClient.appAddress.toString() }
}

async function bindVault(factoryClient: AppClient, vaultSpec: Arc56Contract, vaultId: bigint, ownerAddr: string): Promise<void> {
  await factoryClient.send.call({
    method: 'setVaultApprovalHash(byte[])void',
    args: [specProgramHash(vaultSpec, 'ClaimsVault.arc56.json')],
    sender: ownerAddr,
    suppressLog: true,
  })
  await factoryClient.send.call({
    method: 'setVault(uint64)void',
    args: [vaultId],
    sender: ownerAddr,
    appReferences: [vaultId],
    suppressLog: true,
  })
}

/**
 * Deploy a Factory, fund it, deploy + bind the official vault, and optionally configure the campaign hash.
 *
 * Starts a fresh fixture scope, so each call is isolated from earlier tests.
 *
 * @param fixture The Algorand fixture.
 * @param options Deployment options.
 * @returns The deployed stack with platform accounts.
 */
export async function deployStack(fixture: AlgorandFixture, options: DeployStackOptions = {}): Promise<ContractStack> {
  await fixture.newScope()
  const algorand = fixture.context.algorand
  const specs = loadContractSpecs()
  const owner = await fixture.context.generateAccount({ initialFunds: (options.ownerAlgo ?? 50).algo(), suppressLog: true })
  const sweeper = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
  const ownerAddress = owner.addr.toString()
  const sweeperAddress = sweeper.addr.toString()
  const fundVault = options.fundVault ?? DEPLOY_FUNDING
  const configureCampaignHash = options.configureCampaignHash ?? true

  const ownerBefore = await accountInfo(algorand, ownerAddress)
  const factory = await deployFactory(algorand, specs.factory, ownerAddress)
  const vault = await deployVault(algorand, specs.vault, {
    factoryId: factory.appId,
    ownerAddr: ownerAddress,
    sweeperAddr: sweeperAddress,
    windowSeconds: options.vaultWindowSeconds ?? TEST_VAULT_WINDOW,
    funding: fundVault,
  })
  await bindVault(factory.client, specs.vault, vault.appId, ownerAddress)
  if (configureCampaignHash) {
    await factory.client.send.call({
      method: 'setApprovalHash(byte[])void',
      args: [specProgramHash(specs.campaign, 'Campaign.arc56.json')],
      sender: ownerAddress,
      suppressLog: true,
    })
  }

  const ownerAfter = await accountInfo(algorand, ownerAddress)
  const operations = 3 + (fundVault > 0n ? 1 : 0) + 2 + (configureCampaignHash ? 1 : 0)
  expect(ownerAfter.minBalance - ownerBefore.minBalance).toEqual(FACTORY_MBR + VAULT_MBR)
  expect(ownerBefore.balance - ownerAfter.balance - DEPLOY_FUNDING - fundVault).toEqual(BigInt(operations) * FEE)
  expect(await accountInfo(algorand, factory.address)).toEqual({ balance: DEPLOY_FUNDING, minBalance: APP_BASE })
  expect(await accountInfo(algorand, vault.address)).toEqual({ balance: fundVault, minBalance: APP_BASE })

  return { algorand, specs, owner, sweeper, ownerAddress, sweeperAddress, factory, vault }
}

/**
 * Register a pristine campaign and assert the deposit + fee ledger.
 *
 * @param stack The deployed stack.
 * @param appId The campaign app id.
 * @param creatorAddr The campaign creator (the payer).
 */
export async function registerCampaign(stack: ContractStack, appId: bigint, creatorAddr: string): Promise<void> {
  const factoryClient = new AppFactory({
    appSpec: stack.specs.factory,
    algorand: stack.algorand,
    defaultSender: creatorAddr,
  }).getAppClientById({
    appId: stack.factory.appId,
  })
  const creatorBefore = await accountInfo(stack.algorand, creatorAddr)
  const factoryBefore = await accountInfo(stack.algorand, stack.factory.address)
  const registerPayment = await stack.algorand.createTransaction.payment({
    sender: creatorAddr,
    receiver: factoryClient.appAddress,
    amount: microAlgos(REGISTER_MBR),
  })
  await factoryClient.send.call({
    method: 'register(uint64,pay)void',
    args: [appId, registerPayment],
    sender: creatorAddr,
    appReferences: [appId],
    suppressLog: true,
  })
  const creatorAfter = await accountInfo(stack.algorand, creatorAddr)
  const factoryAfter = await accountInfo(stack.algorand, stack.factory.address)
  expect(creatorBefore.balance - creatorAfter.balance - REGISTER_MBR).toEqual(REGISTER_FEES)
  expect(creatorAfter.minBalance).toEqual(creatorBefore.minBalance)
  expect(factoryAfter.minBalance - factoryBefore.minBalance).toEqual(REGISTER_MBR)
  expect(factoryAfter.balance - factoryBefore.balance).toEqual(REGISTER_MBR)
}

/** Options for {@link deployCampaign}. */
export interface DeployCampaignOptions {
  /** Funding target. Defaults to {@link DEFAULT_GOAL}. */
  goal?: bigint
  /** Seconds from chain time to the deadline. Defaults to 600. */
  deadlineOffset?: number
  /** Campaign title. */
  title?: string
  /** Metadata URI. */
  uri?: string
  /** Vault app id embedded in the campaign. Defaults to the stack's bound vault. */
  vaultId?: bigint
  /** Register before returning. Defaults to true. */
  register?: boolean
}

/**
 * Deploy a campaign against the stack's vault, optionally registering it, and assert the create ledger.
 *
 * @param stack The deployed stack.
 * @param creatorAddr The campaign creator.
 * @param options Campaign options.
 * @returns The campaign client and app id.
 */
export async function deployCampaign(
  stack: ContractStack,
  creatorAddr: string,
  options: DeployCampaignOptions = {},
): Promise<{ appClient: AppClient; appId: bigint }> {
  const creatorBefore = await accountInfo(stack.algorand, creatorAddr)
  const status = await stack.algorand.client.algod.status().do()
  const block = await stack.algorand.client.algod.block(status.lastRound).do()
  const deadline = block.block.header.timestamp + BigInt(options.deadlineOffset ?? 600)
  const vaultId = options.vaultId ?? stack.vault.appId
  const factory = new AppFactory({ appSpec: stack.specs.campaign, algorand: stack.algorand, defaultSender: creatorAddr })
  const { appClient } = await factory.send.create({
    method: 'create(uint64,byte[],byte[],uint64,uint64)void',
    args: [
      vaultId,
      new TextEncoder().encode(options.title ?? 'Seed campaign'),
      new TextEncoder().encode(options.uri ?? 'ipfs://seed'),
      options.goal ?? DEFAULT_GOAL,
      deadline,
    ],
    sender: creatorAddr,
    appReferences: [vaultId],
    suppressLog: true,
  })
  const appId = appClient.appId
  const creatorAfterCreate = await accountInfo(stack.algorand, creatorAddr)
  expect(creatorBefore.balance - creatorAfterCreate.balance).toEqual(CREATE_FEE)
  expect(creatorAfterCreate.minBalance - creatorBefore.minBalance).toEqual(CAMPAIGN_MBR)
  expect(await accountInfo(stack.algorand, appClient.appAddress.toString())).toEqual({ balance: 0n, minBalance: APP_BASE })
  if (options.register ?? true) await registerCampaign(stack, appId, creatorAddr)
  return { appClient, appId }
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
    appReferences: [stack.factory.appId],
    boxReferences: [vaultBoxRef(stack.vault.appId, appId), registrationBoxRef(stack.factory.appId, appId)],
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
  /**
   * Add a second top-level app call (the Factory's readonly `isRegistered`) so the group starts with 1,400 opcodes
   * instead of 700. The campaign's path-shape derivation alone can exceed 700 on large trees, before `ensureBudget`
   * runs; the extra call lets the heavy boundary tests reach sizes the single-call client path cannot. See #162.
   */
  budgetBooster?: boolean
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
): Promise<void> {
  const backerBefore = await accountInfo(stack.algorand, backerAddr)
  const vaultBefore = await accountInfo(stack.algorand, stack.vault.address)
  const path = oracle.path(k)
  const blob = concatHex([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
  const composer = stack.algorand.newGroup()
  if (options.budgetBooster === true) {
    composer.addAppCallMethodCall({
      appId: stack.factory.appId,
      method: ABIMethod.fromSignature('isRegistered(uint64)bool'),
      args: [appId],
      sender: backerAddr,
      boxReferences: [registrationBoxRef(stack.factory.appId, appId)],
    })
  }
  composer.addAppCallMethodCall({
    appId,
    method: ABIMethod.fromSignature(method),
    args: [BigInt(k), amount, Buffer.from(txidHex, 'hex'), blob],
    sender: backerAddr,
    appReferences: [stack.vault.appId],
    boxReferences: [vaultBoxRef(stack.vault.appId, appId)],
    extraFee: microAlgos(spendExtraFee(path, 2)),
  })
  await composer.send({ suppressLog: true })
  const backerAfter = await accountInfo(stack.algorand, backerAddr)
  const vaultAfter = await accountInfo(stack.algorand, stack.vault.address)
  const boosterFee = options.budgetBooster === true ? FEE : 0n
  expect(backerAfter.balance - backerBefore.balance).toEqual(amount - spendFee(path, 2) - boosterFee)
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
): Promise<void> {
  const backerBefore = await accountInfo(stack.algorand, backerAddr)
  const vaultBefore = await accountInfo(stack.algorand, stack.vault.address)
  const path = oracle.path(k)
  const blob = concatHex([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
  const composer = stack.algorand.newGroup()
  if (options.budgetBooster === true) {
    composer.addAppCallMethodCall({
      appId: stack.factory.appId,
      method: ABIMethod.fromSignature('isRegistered(uint64)bool'),
      args: [appId],
      sender: backerAddr,
      boxReferences: [registrationBoxRef(stack.factory.appId, appId)],
    })
  }
  composer.addAppCallMethodCall({
    appId: stack.vault.appId,
    method: ABIMethod.fromSignature('refund(uint64,uint64,uint64,byte[],byte[])void'),
    args: [appId, BigInt(k), amount, Buffer.from(txidHex, 'hex'), blob],
    sender: backerAddr,
    boxReferences: [vaultBoxRef(stack.vault.appId, appId)],
    extraFee: microAlgos(spendExtraFee(path, 1)),
  })
  await composer.send({ suppressLog: true })
  const backerAfter = await accountInfo(stack.algorand, backerAddr)
  const vaultAfter = await accountInfo(stack.algorand, stack.vault.address)
  const boosterFee = options.budgetBooster === true ? FEE : 0n
  expect(backerAfter.balance - backerBefore.balance).toEqual(amount - spendFee(path, 1) - boosterFee)
  expect(backerAfter.minBalance).toEqual(backerBefore.minBalance)
  expect(vaultBefore.balance - vaultAfter.balance).toEqual(amount)
  expect(vaultAfter.minBalance).toEqual(vaultBefore.minBalance)

  const exp = oracle.spend(k, amount)
  const box = await campaignBox(stack.vault.client, appId)
  expect(box.root).toEqual(exp.root)
  expect(box.paidOut).toEqual(box.paidIn - BigInt(exp.raised))
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

/** Options for {@link deleteCampaign}. */
export interface DeleteCampaignOptions {
  /** The campaign was registered, so the deposit returns. Defaults to true. */
  registered?: boolean
  /** The delete releases the vault box (`Claimed`). Defaults to false. */
  vaultBoxRelease?: boolean
}

/**
 * Delete a campaign through the required atomic `[unregister, delete]` group, asserting the cleanup ledger.
 *
 * @param stack The deployed stack.
 * @param appId The campaign app id.
 * @param creatorAddr The campaign creator.
 * @param options Cleanup expectations.
 */
export async function deleteCampaign(
  stack: ContractStack,
  appId: bigint,
  creatorAddr: string,
  options: DeleteCampaignOptions = {},
): Promise<void> {
  const registered = options.registered ?? true
  const vaultBoxRelease = options.vaultBoxRelease ?? false
  const creatorBefore = await accountInfo(stack.algorand, creatorAddr)
  const factoryBefore = await accountInfo(stack.algorand, stack.factory.address)
  const vaultBefore = await accountInfo(stack.algorand, stack.vault.address)
  const composer = stack.algorand.send.newGroup()
  composer.addAppCallMethodCall({
    appId: stack.factory.appId,
    method: ABIMethod.fromSignature('unregister(uint64)void'),
    args: [appId],
    sender: creatorAddr,
    appReferences: [appId],
    extraFee: microAlgos(FEE),
  })
  composer.addAppCallMethodCall({
    appId,
    method: ABIMethod.fromSignature('delete()void'),
    args: [],
    sender: creatorAddr,
    onComplete: OnApplicationComplete.DeleteApplicationOC,
    appReferences: [stack.vault.appId],
    boxReferences: [vaultBoxRef(stack.vault.appId, appId)],
    extraFee: microAlgos(2n * FEE),
  })
  await composer.send({ suppressLog: true })
  const creatorAfter = await accountInfo(stack.algorand, creatorAddr)
  const factoryAfter = await accountInfo(stack.algorand, stack.factory.address)
  const vaultAfter = await accountInfo(stack.algorand, stack.vault.address)
  expect(creatorBefore.minBalance - creatorAfter.minBalance).toEqual(CAMPAIGN_MBR)
  expect(creatorAfter.balance - creatorBefore.balance).toEqual((registered ? REGISTER_MBR : 0n) - CLEANUP_FEES)
  expect(factoryBefore.minBalance - factoryAfter.minBalance).toEqual(registered ? REGISTER_MBR : 0n)
  expect(factoryBefore.balance - factoryAfter.balance).toEqual(registered ? REGISTER_MBR : 0n)
  expect(vaultBefore.minBalance - vaultAfter.minBalance).toEqual(vaultBoxRelease ? VAULT_BOX_MBR : 0n)
}

/**
 * The program hash of a deployed campaign, exactly what the Factory verifies.
 *
 * @param algorand The LocalNet client.
 * @param appId The deployed campaign app id.
 * @returns The 32-byte hash.
 */
export async function campaignApprovalHash(algorand: AlgorandClient, appId: bigint): Promise<Uint8Array> {
  const info = await algorand.app.getById(appId)
  return programHash(Buffer.from(info.approvalProgram), Buffer.from(info.clearStateProgram))
}

/**
 * Call the Factory's readonly `isRegistered`.
 *
 * @param factoryClient The deployed Factory client.
 * @param appId The campaign app id.
 * @param callerAddr The address paying for the readonly call.
 * @returns The boolean return value.
 */
export async function isRegistered(factoryClient: AppClient, appId: bigint, callerAddr: string): Promise<boolean> {
  const result = await factoryClient.send.call({
    method: 'isRegistered(uint64)bool',
    args: [appId],
    sender: callerAddr,
    appReferences: [appId],
    suppressLog: true,
  })
  return Boolean(result.return)
}
