import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import { PLATFORM_STORAGE_RESERVE_MICRO_ALGOS } from '@kasakame/constants/source'
import { specProgramHash } from '@kasakame/utils'
import fs from 'node:fs'
import path from 'node:path'
import { resolveDeployerAccount } from './deployer'
import { parseRefundWindow, resolveSweepTarget } from './refund-window'

/**
 * Read a compiled ARC-56 spec and return its program hash.
 *
 * @param relativePath Path under `smart_contracts/artifacts`.
 * @param name Spec name, used in the missing-bytecode error.
 * @returns The SHA-256 hash of the approval + clear-state programs.
 */
function artifactProgramHash(relativePath: string, name: string): Uint8Array {
  const spec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../smart_contracts/artifacts', relativePath), 'utf8')) as Arc56Contract
  return specProgramHash(spec, name)
}

/**
 * Deploys the platform's `Registry` - the ownerless registry fixed at create (hashes, sweep target, refund window).
 *
 * @returns The deployed Registry's app id - feed it to the ClaimsVault deployer and configure it as
 * `VITE_REGISTRY_APP_ID` in the frontend.
 */
export async function deploy() {
  const algorand = AlgorandClient.fromEnvironment()

  const deployer = await resolveDeployerAccount(algorand)
  const isLocalNet = process.env.ALGOD_SERVER === undefined || process.env.ALGOD_SERVER.includes('localhost')
  const sweepTarget = resolveSweepTarget(process.env.SWEEP_TARGET, deployer.addr.toString(), isLocalNet)
  const refundWindow = parseRefundWindow(process.env.REFUND_WINDOW_SECONDS)

  const specPath = path.resolve(__dirname, '../smart_contracts/artifacts/registry/Registry.arc56.json')
  const appSpec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as Arc56Contract
  const registry = new AppFactory({ appSpec, algorand, defaultSender: deployer.addr })

  const { appClient } = await registry.send.create({
    method: 'create(byte[],byte[],address,uint64)void',
    args: [
      artifactProgramHash('campaign/Campaign.arc56.json', 'Campaign.arc56.json'),
      artifactProgramHash('claimsvault/ClaimsVault.arc56.json', 'ClaimsVault.arc56.json'),
      sweepTarget,
      refundWindow,
    ],
    sender: deployer.addr,
  })

  // Platform storage reserve: the account base plus headroom for registration deposits, which unregister pays back.
  await algorand.send.payment({
    sender: deployer.addr,
    receiver: appClient.appAddress,
    amount: microAlgos(PLATFORM_STORAGE_RESERVE_MICRO_ALGOS),
  })

  console.log(
    `Deployed Registry app ${appClient.appId.toString()} at ${appClient.appAddress.toString()}. ` +
      `Set VITE_REGISTRY_APP_ID=${appClient.appId.toString()} in the frontend's .env.localnet (or .env.testnet for TestNet).`,
  )
  return appClient.appId
}
