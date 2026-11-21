import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { specProgramHash } from '@kasakame/utils'
import { FEE, accountInfo, deployPlatform, type PlatformStack } from '@kasakame/utils/testing'
import type { Account } from 'algosdk'
import { ABIMethod, OnApplicationComplete } from 'algosdk'
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import {
  APP_BASE,
  CAMPAIGN_MBR,
  CLEANUP_FEES,
  CREATE_FEE,
  DEFAULT_GOAL,
  DEPLOY_FUNDING,
  REGISTER_FEES,
  REGISTER_MBR,
  REGISTRY_MBR,
  TEST_VAULT_WINDOW,
  VAULT_BOX_MBR,
  VAULT_MBR,
} from './campaign'
import { vaultBoxRef } from './state'

/** The three ARC-56 specs the integration suites deploy. */
export interface ContractSpecs {
  campaign: Arc56Contract
  registry: Arc56Contract
  vault: Arc56Contract
}

function readSpec(relativePath: string): Arc56Contract {
  const file = path.resolve(__dirname, '../../smart_contracts/artifacts', relativePath)
  if (!fs.existsSync(file)) throw new Error(`${relativePath} not found; run \`npm run build\` first.`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Arc56Contract
}

/** @returns The compiled ARC-56 specs (requires `npm run build`). */
export function loadContractSpecs(): ContractSpecs {
  return {
    campaign: readSpec('campaign/Campaign.arc56.json'),
    registry: readSpec('registry/Registry.arc56.json'),
    vault: readSpec('claimsvault/ClaimsVault.arc56.json'),
  }
}

/** A deployed Registry + bound ClaimsVault, plus the platform accounts and specs. */
export interface ContractStack extends PlatformStack {
  specs: ContractSpecs
  owner: Account
  sweeper: Account
  ownerAddress: string
  sweeperAddress: string
}

/** Options for {@link deployStack}. */
export interface DeployStackOptions {
  /** ALGO funded to the platform deployer. Defaults to 50. */
  ownerAlgo?: number
  /** Refund window for the test vault. Defaults to {@link TEST_VAULT_WINDOW}. */
  vaultWindowSeconds?: bigint
  /** ALGO funded to the vault app account. Defaults to {@link DEPLOY_FUNDING}; use 0 to assert a bare vault. */
  fundVault?: bigint
  /** Bind the vault to the Registry. Defaults to true; bind-guard tests start unbound. */
  bindVault?: boolean
  /** Override the campaign hash committed at Registry create (test-only). */
  campaignProgramHash?: Uint8Array
  /** Override the vault hash committed at Registry create (test-only). */
  vaultProgramHash?: Uint8Array
  /** Override the sweep target committed at Registry create (test-only; defaults to the sweeper). */
  registrySweepTarget?: string
  /** Override the refund window committed at Registry create (test-only; defaults to the vault window). */
  registryWindowSeconds?: bigint
}

/**
 * Deploy a Registry, fund it, deploy + bind the official vault, and assert the deployment ledger.
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
  const bindVaultToRegistry = options.bindVault ?? true
  const windowSeconds = options.vaultWindowSeconds ?? TEST_VAULT_WINDOW

  const ownerBefore = await accountInfo(algorand, ownerAddress)
  const { registry, vault } = await deployPlatform(algorand, {
    specs: { registry: specs.registry, vault: specs.vault },
    owner,
    sweepTarget: sweeperAddress,
    vaultWindowSeconds: windowSeconds,
    campaignProgramHash: options.campaignProgramHash ?? specProgramHash(specs.campaign, 'Campaign.arc56.json'),
    vaultProgramHash: options.vaultProgramHash ?? specProgramHash(specs.vault, 'ClaimsVault.arc56.json'),
    registrySweepTarget: options.registrySweepTarget ?? sweeperAddress,
    registryWindowSeconds: options.registryWindowSeconds ?? windowSeconds,
    vaultFunding: fundVault,
    bindVault: bindVaultToRegistry,
  })

  const ownerAfter = await accountInfo(algorand, ownerAddress)
  const operations = 3 + (fundVault > 0n ? 1 : 0) + (bindVaultToRegistry ? 1 : 0)
  expect(ownerAfter.minBalance - ownerBefore.minBalance).toEqual(REGISTRY_MBR + VAULT_MBR)
  expect(ownerBefore.balance - ownerAfter.balance - DEPLOY_FUNDING - fundVault).toEqual(BigInt(operations) * FEE)
  expect(await accountInfo(algorand, registry.address)).toEqual({ balance: DEPLOY_FUNDING, minBalance: APP_BASE })
  expect(await accountInfo(algorand, vault.address)).toEqual({ balance: fundVault, minBalance: APP_BASE })

  return { algorand, specs, owner, sweeper, ownerAddress, sweeperAddress, registry, vault }
}

/**
 * Register a pristine campaign and assert the deposit + fee ledger.
 *
 * @param stack The deployed stack.
 * @param appId The campaign app id.
 * @param creatorAddr The campaign creator (the payer).
 */
export async function registerCampaign(stack: ContractStack, appId: bigint, creatorAddr: string): Promise<void> {
  const registryClient = new AppFactory({
    appSpec: stack.specs.registry,
    algorand: stack.algorand,
    defaultSender: creatorAddr,
  }).getAppClientById({
    appId: stack.registry.appId,
  })
  const creatorBefore = await accountInfo(stack.algorand, creatorAddr)
  const registryBefore = await accountInfo(stack.algorand, stack.registry.address)
  const registerPayment = await stack.algorand.createTransaction.payment({
    sender: creatorAddr,
    receiver: registryClient.appAddress,
    amount: microAlgos(REGISTER_MBR),
  })
  await registryClient.send.call({
    method: 'register(uint64,pay)void',
    args: [appId, registerPayment],
    sender: creatorAddr,
    appReferences: [appId],
    suppressLog: true,
  })
  const creatorAfter = await accountInfo(stack.algorand, creatorAddr)
  const registryAfter = await accountInfo(stack.algorand, stack.registry.address)
  expect(creatorBefore.balance - creatorAfter.balance - REGISTER_MBR).toEqual(REGISTER_FEES)
  expect(creatorAfter.minBalance).toEqual(creatorBefore.minBalance)
  expect(registryAfter.minBalance - registryBefore.minBalance).toEqual(REGISTER_MBR)
  expect(registryAfter.balance - registryBefore.balance).toEqual(REGISTER_MBR)
}

/** Options for {@link deployCampaign}. */
export interface DeployCampaignOptions {
  /** Funding target. Defaults to {@link DEFAULT_GOAL}. */
  goal?: bigint
  /** Seconds from chain time to the deadline. Defaults to one day. */
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
  const deadline = block.block.header.timestamp + BigInt(options.deadlineOffset ?? 24 * 60 * 60)
  const vaultId = options.vaultId ?? stack.vault.appId
  const registry = new AppFactory({ appSpec: stack.specs.campaign, algorand: stack.algorand, defaultSender: creatorAddr })
  const { appClient } = await registry.send.create({
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
  const registryBefore = await accountInfo(stack.algorand, stack.registry.address)
  const vaultBefore = await accountInfo(stack.algorand, stack.vault.address)
  const composer = stack.algorand.send.newGroup()
  composer.addAppCallMethodCall({
    appId: stack.registry.appId,
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
  const registryAfter = await accountInfo(stack.algorand, stack.registry.address)
  const vaultAfter = await accountInfo(stack.algorand, stack.vault.address)
  expect(creatorBefore.minBalance - creatorAfter.minBalance).toEqual(CAMPAIGN_MBR)
  expect(creatorAfter.balance - creatorBefore.balance).toEqual((registered ? REGISTER_MBR : 0n) - CLEANUP_FEES)
  expect(registryBefore.minBalance - registryAfter.minBalance).toEqual(registered ? REGISTER_MBR : 0n)
  expect(registryBefore.balance - registryAfter.balance).toEqual(registered ? REGISTER_MBR : 0n)
  expect(vaultBefore.minBalance - vaultAfter.minBalance).toEqual(vaultBoxRelease ? VAULT_BOX_MBR : 0n)
}

/**
 * Call the Registry's readonly `isRegistered`.
 *
 * @param registryClient The deployed Registry client.
 * @param appId The campaign app id.
 * @param callerAddr The address paying for the readonly call.
 * @returns The boolean return value.
 */
export async function isRegistered(registryClient: AppClient, appId: bigint, callerAddr: string): Promise<boolean> {
  const result = await registryClient.send.call({
    method: 'isRegistered(uint64)bool',
    args: [appId],
    sender: callerAddr,
    appReferences: [appId],
    suppressLog: true,
  })
  return Boolean(result.return)
}
