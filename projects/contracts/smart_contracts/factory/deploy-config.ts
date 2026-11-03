import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveDeployerAccount } from '../deployer'

/**
 * Deploys the platform's `Factory` application - the canonical campaign registry.
 *
 * The deployer is the Factory owner (the only account allowed to configure the official program hash). The Factory's application account
 * is funded with 1 ALGO (the platform storage reserve: the account base plus headroom for registration deposits), and the official hash is
 * set to the SHA-256 of the compiled `Campaign` approval **and clear-state** programs so `register()` can tell official campaigns apart
 * from copies.
 *
 * @returns The deployed Factory's app id - configure it as `VITE_FACTORY_APP_ID` in the frontend.
 */
export async function deploy() {
  const algorand = AlgorandClient.fromEnvironment()

  const deployer = await resolveDeployerAccount(algorand)

  const specPath = path.resolve(__dirname, '../artifacts/factory/Factory.arc56.json')
  const appSpec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as Arc56Contract

  const factory = new AppFactory({ appSpec, algorand, defaultSender: deployer.addr })

  const { appClient } = await factory.send.create({
    method: 'create()void',
    args: [],
    sender: deployer.addr,
  })

  // Platform storage reserve: the Factory account base (0.1 ALGO) plus headroom; registration deposits add ~0.019 ALGO each and are paid
  // back on unregister, so the balance stays roughly constant.
  await algorand.send.payment({
    sender: deployer.addr,
    receiver: appClient.appAddress,
    amount: microAlgos(1_000_000n),
  })

  // The official Campaign program hash: SHA-256 over `itob(approval.length) ‖ approval ‖ clear`, using the ARC-56
  // bytecode (exactly what the SDK/AppFactory deploys) - not recompiled TEAL, which could differ across assembler
  // versions. The 8-byte length prefix makes the approval/clear split unambiguous.
  const campaignSpecPath = path.resolve(__dirname, '../artifacts/campaign/Campaign.arc56.json')
  const campaignSpec = JSON.parse(fs.readFileSync(campaignSpecPath, 'utf8')) as Arc56Contract
  if (campaignSpec.byteCode === undefined) {
    throw new Error('Campaign.arc56.json has no byteCode; run `npm run build` first.')
  }
  const approvalProgram = Buffer.from(campaignSpec.byteCode.approval, 'base64')
  const clearStateProgram = Buffer.from(campaignSpec.byteCode.clear, 'base64')
  const approvalLength = Buffer.alloc(8)
  approvalLength.writeBigUInt64BE(BigInt(approvalProgram.length))
  const programHash = createHash('sha256').update(approvalLength).update(approvalProgram).update(clearStateProgram).digest()

  await appClient.send.call({
    method: 'setApprovalHash(byte[])void',
    args: [programHash],
    sender: deployer.addr,
  })

  console.log(
    `Deployed Factory app ${appClient.appId.toString()} at ${appClient.appAddress.toString()}. ` +
      `Set VITE_FACTORY_APP_ID=${appClient.appId.toString()} in the frontend's .env.localnet (or .env.testnet for TestNet).`,
  )
  return appClient.appId
}
