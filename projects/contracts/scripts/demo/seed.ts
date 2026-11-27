import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import { REGISTER_DEPOSIT_MICRO_ALGOS, SECONDS_PER_DAY } from '@kasakame/constants/source'
import { ABIMethod } from 'algosdk'
import fs from 'node:fs'
import path from 'node:path'
import { CAMPAIGNS_LOCALNET, CAMPAIGNS_TESTNET } from './campaigns'
import { STATE_PATH, appIdBytes, isLocalNet, writeSeedState, type SeedEntry } from './state'

/**
 * Seed demo `Campaign` apps; `SEED_METADATA_URIS` overrides the default `ipfs://seed/<creator>` metadata in table order.
 */

const SPEC_PATH = path.resolve(__dirname, '../../smart_contracts/artifacts/campaign/Campaign.arc56.json')
const REGISTRY_SPEC_PATH = path.resolve(__dirname, '../../smart_contracts/artifacts/registry/Registry.arc56.json')
const VAULT_SPEC_PATH = path.resolve(__dirname, '../../smart_contracts/artifacts/claimsvault/ClaimsVault.arc56.json')

function toMicroAlgos(algo: number): bigint {
  return BigInt(Math.round(algo * 1_000_000))
}

void (async () => {
  const algorand = isLocalNet ? AlgorandClient.defaultLocalNet() : AlgorandClient.fromEnvironment()
  const campaigns = isLocalNet ? CAMPAIGNS_LOCALNET : CAMPAIGNS_TESTNET
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as Arc56Contract
  const registrySpec = JSON.parse(fs.readFileSync(REGISTRY_SPEC_PATH, 'utf8')) as Arc56Contract
  const vaultSpec = JSON.parse(fs.readFileSync(VAULT_SPEC_PATH, 'utf8')) as Arc56Contract

  const registryId =
    process.env.REGISTRY_APP_ID !== undefined && process.env.REGISTRY_APP_ID !== '' ? BigInt(process.env.REGISTRY_APP_ID) : 0n
  const vaultId = process.env.VAULT_APP_ID !== undefined && process.env.VAULT_APP_ID !== '' ? BigInt(process.env.VAULT_APP_ID) : 0n
  if (registryId === 0n || vaultId === 0n) {
    throw new Error('REGISTRY_APP_ID and VAULT_APP_ID must both be set (deploy the Registry and the ClaimsVault first).')
  }

  // LocalNet auto-creates and funds a KMD wallet; elsewhere this reads BACKER_A_MNEMONIC (pre-funded).
  const backer = await algorand.account.fromEnvironment('backer_a', (100).algo())

  const seeded: SeedEntry[] = []
  const metadataUris =
    process.env.SEED_METADATA_URIS !== undefined && process.env.SEED_METADATA_URIS !== '' ? process.env.SEED_METADATA_URIS.split(',') : []
  for (const [index, c] of campaigns.entries()) {
    const override = metadataUris[index]
    const metadataUri = override !== undefined && override !== '' ? override : `ipfs://seed/${c.creator}`
    const creator = await algorand.account.fromEnvironment(c.creator, (100).algo())
    const vaultClient = new AppFactory({ appSpec: vaultSpec, algorand, defaultSender: creator.addr }).getAppClientById({ appId: vaultId })

    const campaignFactory = new AppFactory({ appSpec: spec, algorand, defaultSender: creator.addr })

    const goal = toMicroAlgos(c.goalAlgo)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + c.days * SECONDS_PER_DAY)

    const { result } = await campaignFactory.send.create({
      method: 'create(uint64,byte[],byte[],uint64,uint64)void',
      args: [vaultId, new TextEncoder().encode(`${c.creator}'s campaign`), new TextEncoder().encode(metadataUri), goal, deadline],
      sender: creator.addr,
      appReferences: [vaultId],
    })

    // Register with the Registry so the browse page lists the campaign (first-touch credit requires it on-chain).
    const registryClient = new AppFactory({ appSpec: registrySpec, algorand, defaultSender: creator.addr }).getAppClientById({
      appId: registryId,
    })
    const registerPayment = await algorand.createTransaction.payment({
      sender: creator.addr,
      receiver: registryClient.appAddress,
      amount: microAlgos(REGISTER_DEPOSIT_MICRO_ALGOS),
    })
    await registryClient.send.call({
      method: 'register(uint64,pay)void',
      args: [result.appId, registerPayment],
      sender: creator.addr,
      appReferences: [result.appId],
    })

    let pledged = '-'
    if (c.pledgeAlgo > 0) {
      // Real group [pay, campaign.pledge, vault.credit]; one pledge each keeps the frontier empty (N == 0).
      const amount = toMicroAlgos(c.pledgeAlgo)
      const pay = await algorand.createTransaction.payment({
        sender: backer.addr,
        receiver: vaultClient.appAddress,
        amount: microAlgos(amount),
      })
      const composer = algorand.send.newGroup()
      composer.addAppCallMethodCall({
        appId: result.appId,
        method: ABIMethod.fromSignature('pledge(pay,byte[])void'),
        args: [pay, new Uint8Array()],
        sender: backer.addr,
      })
      const appIdBuf = appIdBytes(result.appId)
      composer.addAppCallMethodCall({
        appId: vaultId,
        method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
        args: [result.appId, amount],
        sender: backer.addr,
        // The credit must follow the pledge; first touch checks the campaign's Registry registration.
        appReferences: [registryId],
        boxReferences: [
          { appId: vaultId, name: new Uint8Array(Buffer.concat([Buffer.from('c'), appIdBuf])) },
          { appId: registryId, name: new Uint8Array(Buffer.concat([Buffer.from('r'), appIdBuf])) },
        ],
        extraFee: microAlgos(1_000n),
      })
      await composer.send()
      pledged = `${String(c.pledgeAlgo)} ALGO`
    }

    seeded.push({ appId: result.appId.toString(), creator: c.creator })
    console.log(
      `#${result.appId.toString()} creator=${c.creator} (${creator.addr.toString()}) ` +
        `goal=${String(c.goalAlgo)} ALGO deadline=${new Date(Number(deadline) * 1000).toISOString()} pledged=${pledged}`,
    )
  }

  writeSeedState({ registryId: registryId.toString(), vaultId: vaultId.toString(), campaigns: seeded })
  console.log(`seed state written to ${path.relative(process.cwd(), STATE_PATH)}`)
})()
