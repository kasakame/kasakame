import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { MICRO_ALGOS_PER_ALGO, MIN_REFUND_WINDOW_SECONDS } from '@kasakame/constants'
import { configureSdk } from '@kasakame/sdk'
import { specProgramHash } from '@kasakame/utils'
import { deployPlatform } from '@kasakame/utils/testing'
import type { Account } from 'algosdk'
import { loadCliSpecs } from './specs.js'

/** A deployed Registry + bound ClaimsVault the CLI tests point at. */
export interface CliStack {
  algorand: AlgorandClient
  minFee: bigint
  registryAppId: bigint
  registryAddress: string
  vaultAppId: bigint
  vaultAddress: string
  sweepTarget: string
  owner: Account
}

/**
 * Deploy a fresh Registry + bound ClaimsVault from the specs matching the installed SDK and configure the test-process SDK.
 *
 * @param fixture The Algorand fixture.
 * @returns The deployed stack.
 */
export async function setupCliStack(fixture: AlgorandFixture): Promise<CliStack> {
  await fixture.newScope()
  const algorand = fixture.context.algorand
  const minFee = BigInt((await algorand.getSuggestedParams()).minFee)
  const owner = await fixture.context.generateAccount({
    initialFunds: microAlgos(50n * MICRO_ALGOS_PER_ALGO),
    suppressLog: true,
  })
  const specs = loadCliSpecs()
  const { registry, vault } = await deployPlatform(algorand, {
    specs: { registry: specs.registry, vault: specs.vault },
    owner,
    sweepTarget: owner.addr.toString(),
    vaultWindowSeconds: BigInt(MIN_REFUND_WINDOW_SECONDS),
    campaignProgramHash: specProgramHash(specs.campaign, 'Campaign'),
  })
  const stack: CliStack = {
    algorand,
    minFee,
    registryAppId: registry.appId,
    registryAddress: registry.address,
    vaultAppId: vault.appId,
    vaultAddress: vault.address,
    sweepTarget: owner.addr.toString(),
    owner,
  }
  configureCliStack(stack)
  return stack
}

/**
 * Point the test-process SDK at the stack, optionally creating campaigns that are not registered.
 *
 * @param stack The deployed stack.
 * @param registryAppId Registry id to use; `0n` creates campaigns without a registration.
 */
export function configureCliStack(stack: CliStack, registryAppId = stack.registryAppId): void {
  configureSdk({ algorand: stack.algorand, registryAppId, vaultAppId: stack.vaultAppId })
}
