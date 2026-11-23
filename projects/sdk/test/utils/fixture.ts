import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { MICRO_ALGOS_PER_ALGO, MIN_REFUND_WINDOW_SECONDS } from '@kasakame/constants'
import { specProgramHash } from '@kasakame/utils'
import { deployPlatform } from '@kasakame/utils/testing'
import { CampaignFactory } from '../../src/generated/CampaignClient.js'
import { ClaimsVaultFactory } from '../../src/generated/ClaimsVaultClient.js'
import { RegistryFactory } from '../../src/generated/RegistryClient.js'
import { configureSdk, type WalletSession } from '../../src/index.js'

/** The deployed Registry + vault and the SDK session they are configured for. */
export interface SdkStack {
  /** The configured Algorand client. */
  algorand: AlgorandClient
  /** The LocalNet minimum transaction fee observed at setup. */
  minFee: bigint
  /** The deployed Registry application id. */
  registryAppId: bigint
  /** The deployed Registry application account address. */
  registryAddress: string
  /** The deployed ClaimsVault application id. */
  vaultAppId: bigint
  /** The deployed ClaimsVault application account address. */
  vaultAddress: string
}

/**
 * Start a fresh fixture scope, deploy the Registry + ClaimsVault from the generated clients' ARC-56 bytecode, and configure the SDK against them.
 *
 * @param fixture The Algorand fixture.
 * @returns The configured stack.
 */
export async function setupSdkStack(fixture: AlgorandFixture): Promise<SdkStack> {
  await fixture.newScope()
  const algorand = fixture.context.algorand
  const minFee = BigInt((await algorand.getSuggestedParams()).minFee)
  const owner = await fixture.context.generateAccount({
    initialFunds: microAlgos(50n * MICRO_ALGOS_PER_ALGO),
    suppressLog: true,
  })
  const ownerAddress = owner.addr.toString()

  const campaignFactory = new CampaignFactory({ algorand, defaultSender: ownerAddress })
  const vaultFactory = new ClaimsVaultFactory({ algorand, defaultSender: ownerAddress })
  const registryFactory = new RegistryFactory({ algorand, defaultSender: ownerAddress })

  const { registry, vault } = await deployPlatform(algorand, {
    specs: { registry: registryFactory.appSpec, vault: vaultFactory.appSpec },
    owner,
    sweepTarget: ownerAddress,
    vaultWindowSeconds: BigInt(MIN_REFUND_WINDOW_SECONDS),
    campaignProgramHash: specProgramHash(campaignFactory.appSpec, 'Campaign'),
  })

  configureSdk({ algorand, registryAppId: registry.appId, vaultAppId: vault.appId })
  return {
    algorand,
    minFee,
    registryAppId: registry.appId,
    registryAddress: registry.address,
    vaultAppId: vault.appId,
    vaultAddress: vault.address,
  }
}

/**
 * Generate a funded throwaway account and wrap it as a wallet session.
 *
 * @param fixture The Algorand fixture.
 * @param initialAlgos Starting balance in ALGO.
 * @returns The wallet session.
 */
export async function session(fixture: AlgorandFixture, initialAlgos: bigint): Promise<WalletSession> {
  const account = await fixture.context.generateAccount({
    initialFunds: microAlgos(initialAlgos * MICRO_ALGOS_PER_ALGO),
    suppressLog: true,
  })
  return { address: account.addr.toString(), signer: account.signer }
}
