import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import { PLATFORM_STORAGE_RESERVE_MICRO_ALGOS } from '@kasakame/constants'
import type { Account } from 'algosdk'
import { specProgramHash } from '../program-hash.js'
import { assertBalance } from './assertions.js'
import { accountInfo } from './localnet.js'

/** A deployed application. */
export interface DeployedApp {
  client: AppClient
  appId: bigint
  address: string
}

/** The Registry and ClaimsVault specs a platform deploy needs. */
export interface PlatformSpecs {
  registry: Arc56Contract
  vault: Arc56Contract
}

/** A deployed Registry + bound ClaimsVault. */
export interface PlatformStack {
  algorand: AlgorandClient
  registry: DeployedApp
  vault: DeployedApp
}

/** Options for {@link deployPlatform}. */
export interface DeployPlatformOptions {
  /** Compiled Registry and ClaimsVault specs. */
  specs: PlatformSpecs
  /** Pays for both deployments and the app-account funding. */
  owner: Account
  /** Address committed as the expected sweep target in the Registry and the vault. */
  sweepTarget: string
  /** Refund window committed to both apps (seconds). */
  vaultWindowSeconds: bigint
  /** Campaign program hash committed at Registry create. */
  campaignProgramHash: Uint8Array
  /** Vault program hash committed at Registry create. Defaults to the vault spec's hash. */
  vaultProgramHash?: Uint8Array
  /** Override the Registry's sweep target (test-only). */
  registrySweepTarget?: string
  /** Override the Registry's refund window (test-only). */
  registryWindowSeconds?: bigint
  /** ALGO funded to the Registry app account. Defaults to 1 ALGO. */
  registryFunding?: bigint
  /** ALGO funded to the vault app account. Defaults to 1 ALGO. */
  vaultFunding?: bigint
  /** Bind the vault to the Registry. Defaults to true. */
  bindVault?: boolean
}

async function fund(algorand: AlgorandClient, sender: string, receiver: string, amount: bigint): Promise<void> {
  if (amount === 0n) return
  await algorand.send.payment({ sender, receiver, amount: microAlgos(amount), suppressLog: true })
}

async function createRegistry(
  algorand: AlgorandClient,
  spec: Arc56Contract,
  options: DeployPlatformOptions,
  windowSeconds: bigint,
): Promise<DeployedApp> {
  const ownerAddress = options.owner.addr.toString()
  const factory = new AppFactory({ appSpec: spec, algorand, defaultSender: ownerAddress })
  const { appClient } = await factory.send.create({
    method: 'create(byte[],byte[],address,uint64)void',
    args: [
      options.campaignProgramHash,
      options.vaultProgramHash ?? specProgramHash(options.specs.vault, 'vault spec'),
      options.registrySweepTarget ?? options.sweepTarget,
      options.registryWindowSeconds ?? windowSeconds,
    ],
    sender: ownerAddress,
    suppressLog: true,
  })
  const funding = options.registryFunding ?? PLATFORM_STORAGE_RESERVE_MICRO_ALGOS
  await fund(algorand, ownerAddress, appClient.appAddress.toString(), funding)
  assertBalance(`registry ${appClient.appId.toString()}`, (await accountInfo(algorand, appClient.appAddress.toString())).balance, funding)
  return { client: appClient, appId: appClient.appId, address: appClient.appAddress.toString() }
}

async function createVault(
  algorand: AlgorandClient,
  spec: Arc56Contract,
  options: DeployPlatformOptions,
  registryId: bigint,
  windowSeconds: bigint,
): Promise<DeployedApp> {
  const ownerAddress = options.owner.addr.toString()
  const factory = new AppFactory({ appSpec: spec, algorand, defaultSender: ownerAddress })
  const { appClient } = await factory.send.create({
    method: 'create(uint64,address,uint64)void',
    args: [registryId, options.sweepTarget, windowSeconds],
    sender: ownerAddress,
    appReferences: [registryId],
    suppressLog: true,
  })
  const funding = options.vaultFunding ?? PLATFORM_STORAGE_RESERVE_MICRO_ALGOS
  await fund(algorand, ownerAddress, appClient.appAddress.toString(), funding)
  assertBalance(`vault ${appClient.appId.toString()}`, (await accountInfo(algorand, appClient.appAddress.toString())).balance, funding)
  return { client: appClient, appId: appClient.appId, address: appClient.appAddress.toString() }
}

/**
 * Deploy the Registry, fund it, deploy the ClaimsVault, and bind it.
 *
 * The Registry fixes the campaign/vault hashes, sweep target, and refund window at `create`; the vault records the
 * Registry id and is bound once. Both app accounts are funded so they can hold their boxes.
 *
 * @param algorand The LocalNet client.
 * @param options Deployment options.
 * @returns The deployed platform stack.
 */
export async function deployPlatform(algorand: AlgorandClient, options: DeployPlatformOptions): Promise<PlatformStack> {
  const windowSeconds = options.vaultWindowSeconds
  const registry = await createRegistry(algorand, options.specs.registry, options, windowSeconds)
  const vault = await createVault(algorand, options.specs.vault, options, registry.appId, windowSeconds)

  if (options.bindVault ?? true) {
    await registry.client.send.call({
      method: 'bindVault(uint64)void',
      args: [vault.appId],
      sender: options.owner.addr.toString(),
      appReferences: [vault.appId],
      suppressLog: true,
    })
  }

  return { algorand, registry, vault }
}
