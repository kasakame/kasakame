import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import { ABIMethod, OnApplicationComplete } from 'algosdk'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { programHash } from '../program-hash'
import { SIZE_BUDGET } from '../size-budget.fixture'

/**
 * LocalNet integration tests for the Factory registry: deploy the Factory, hash a real Campaign's approval program, and exercise
 * register/unregister/isRegistered, including the authorization and impostor guards.
 *
 * Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifacts exist.
 */

const ALGO = 1_000_000n
const TXN_FEE = 1_000n
const REGISTER_MBR = 18_900n // the registration box's minimum balance (2500 + 400 × (9 + 32))
const FACTORY_MBR = BigInt(SIZE_BUDGET.factory.appMbr)
const VAULT_MBR = BigInt(SIZE_BUDGET.claimsvault.appMbr)
const CAMPAIGN_MBR = BigInt(SIZE_BUDGET.campaign.appMbr)
const APP_BASE = 100_000n
const DEPLOY_FUNDING = 1_000_000n
const CREATE_FEE = TXN_FEE

const CAMPAIGN_SPEC_PATH = path.resolve(__dirname, '../artifacts/campaign/Campaign.arc56.json')
const FACTORY_SPEC_PATH = path.resolve(__dirname, '../artifacts/factory/Factory.arc56.json')
const VAULT_SPEC_PATH = path.resolve(__dirname, '../artifacts/claimsvault/ClaimsVault.arc56.json')

describe('Factory (localnet)', () => {
  const fixture = algorandFixture()
  let algorand: AlgorandClient
  let factorySpec: Arc56Contract
  let campaignSpec: Arc56Contract
  let vaultSpec: Arc56Contract

  beforeAll(async () => {
    await fixture.newScope()
    algorand = fixture.context.algorand
    factorySpec = JSON.parse(fs.readFileSync(FACTORY_SPEC_PATH, 'utf8')) as Arc56Contract
    campaignSpec = JSON.parse(fs.readFileSync(CAMPAIGN_SPEC_PATH, 'utf8')) as Arc56Contract
    vaultSpec = JSON.parse(fs.readFileSync(VAULT_SPEC_PATH, 'utf8')) as Arc56Contract
  })

  /**
   * Deploy the Factory, fund its application account, deploy the official vault bound to it, and bind the vault.
   *
   * @param ownerAddr The platform owner's address.
   * @returns The Factory client and the official vault's app id.
   */
  async function deployFactory(ownerAddr: string) {
    const ownerBefore = await accountInfo(ownerAddr)
    const factory = new AppFactory({ appSpec: factorySpec, algorand, defaultSender: ownerAddr })
    const { appClient } = await factory.send.create({ method: 'create()void', args: [], sender: ownerAddr, suppressLog: true })

    // The platform funds the Factory account: the 0.1 ALGO base, so it can hold registration deposits and pay them back.
    await algorand.send.payment({ sender: ownerAddr, receiver: appClient.appAddress, amount: microAlgos(ALGO), suppressLog: true })

    // Deploy the official vault against this Factory, then bind it; `setVault` verifies the back-reference.
    const vaultFactory = new AppFactory({ appSpec: vaultSpec, algorand, defaultSender: ownerAddr })
    const { appClient: vaultClient } = await vaultFactory.send.create({
      method: 'create(uint64,address,uint64)void',
      args: [appClient.appId, ownerAddr, 730n * 24n * 60n * 60n],
      sender: ownerAddr,
      appReferences: [appClient.appId],
      suppressLog: true,
    })
    if (vaultSpec.byteCode === undefined) {
      throw new Error('ClaimsVault.arc56.json has no byteCode; run `npm run build` first.')
    }
    await appClient.send.call({
      method: 'setVaultApprovalHash(byte[])void',
      args: [programHash(Buffer.from(vaultSpec.byteCode.approval, 'base64'), Buffer.from(vaultSpec.byteCode.clear, 'base64'))],
      sender: ownerAddr,
      suppressLog: true,
    })
    await appClient.send.call({
      method: 'setVault(uint64)void',
      args: [vaultClient.appId],
      sender: ownerAddr,
      appReferences: [vaultClient.appId],
      suppressLog: true,
    })
    const ownerAfter = await accountInfo(ownerAddr)
    const deployCost = ownerBefore.balance - ownerAfter.balance
    expect(ownerAfter.minBalance - ownerBefore.minBalance).toEqual(FACTORY_MBR + VAULT_MBR)
    expect(deployCost - DEPLOY_FUNDING).toEqual(5n * TXN_FEE)
    expect(await accountInfo(appClient.appAddress.toString())).toEqual({ balance: DEPLOY_FUNDING, minBalance: APP_BASE })
    expect(await accountInfo(vaultClient.appAddress.toString())).toEqual({ balance: 0n, minBalance: APP_BASE })
    return { factoryClient: appClient, vaultId: vaultClient.appId }
  }

  /**
   * Deploy + fund a real Campaign and return its client.
   *
   * @param creatorAddr The campaign creator's address.
   * @param vaultId The vault app id stored in the campaign.
   */
  async function deployCampaign(creatorAddr: string, vaultId: bigint): Promise<AppClient> {
    const creatorBefore = await accountInfo(creatorAddr)
    // Deadline from chain time (not wall time): other suites time-travel the shared LocalNet clock.
    const status = await algorand.client.algod.status().do()
    const block = await algorand.client.algod.block(status.lastRound).do()
    const deadline = block.block.header.timestamp + 3600n
    const factory = new AppFactory({ appSpec: campaignSpec, algorand, defaultSender: creatorAddr })
    const { appClient } = await factory.send.create({
      method: 'create(uint64,byte[],byte[],uint64,uint64)void',
      args: [vaultId, new TextEncoder().encode('Registrable'), new TextEncoder().encode('ipfs://test'), 1_000_000n, deadline],
      sender: creatorAddr,
      appReferences: [vaultId],
      suppressLog: true,
    })
    const creatorAfter = await accountInfo(creatorAddr)
    expect(creatorAfter.minBalance - creatorBefore.minBalance).toEqual(CAMPAIGN_MBR)
    expect(creatorBefore.balance - creatorAfter.balance).toEqual(CREATE_FEE)
    expect(await accountInfo(appClient.appAddress.toString())).toEqual({ balance: 0n, minBalance: APP_BASE })
    return appClient
  }

  /**
   * The SHA-256 of `itob(approval.length) ‖ approval ‖ clear` for the deployed Campaign, exactly what the Factory verifies.
   *
   * @param appId The deployed Campaign's application id.
   */
  async function campaignApprovalHash(appId: bigint): Promise<Uint8Array> {
    const info = await algorand.app.getById(appId)
    return programHash(Buffer.from(info.approvalProgram), Buffer.from(info.clearStateProgram))
  }

  /**
   * Call the Factory's readonly `isRegistered` and decode the boolean return.
   *
   * @param factoryClient The deployed Factory client.
   * @param appId The campaign application id.
   * @param callerAddr The address paying for the readonly call.
   */
  async function isRegistered(factoryClient: AppClient, appId: bigint, callerAddr: string): Promise<boolean> {
    const result = await factoryClient.send.call({
      method: 'isRegistered(uint64)bool',
      args: [appId],
      sender: callerAddr,
      appReferences: [appId],
      suppressLog: true,
    })
    return Boolean(result.return)
  }

  async function accountInfo(address: string) {
    const info = await algorand.account.getInformation(address)
    return { balance: info.balance.microAlgo, minBalance: info.minBalance.microAlgo }
  }

  test('register/isRegistered/unregister round trip with a real Campaign', { timeout: 120_000 }, async () => {
    const owner = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { factoryClient, vaultId } = await deployFactory(owner.addr.toString())
    const factoryAddress = factoryClient.appAddress.toString()

    const campaignClient = await deployCampaign(creator.addr.toString(), vaultId)
    const campaignId = campaignClient.appId

    // Configure the official hash from the real deployed program.
    const hash = await campaignApprovalHash(campaignId)
    await factoryClient.send.call({
      method: 'setApprovalHash(byte[])void',
      args: [hash],
      sender: owner.addr,
      suppressLog: true,
    })

    // Register: the creator pays the refundable deposit.
    const factoryBefore = await accountInfo(factoryAddress)
    const creatorBeforeRegister = await accountInfo(creator.addr.toString())
    const payment = await algorand.createTransaction.payment({
      sender: creator.addr.toString(),
      receiver: factoryAddress,
      amount: microAlgos(REGISTER_MBR),
    })
    await factoryClient.send.call({
      method: 'register(uint64,pay)void',
      args: [campaignId, payment],
      sender: creator.addr,
      appReferences: [campaignId],
      suppressLog: true,
    })

    // The deposit landed on the Factory account and the registration box parked its MBR on it.
    const factoryAfterRegister = await accountInfo(factoryAddress)
    const creatorAfterRegister = await accountInfo(creator.addr.toString())
    const registerCost = creatorBeforeRegister.balance - creatorAfterRegister.balance
    expect(registerCost - REGISTER_MBR).toEqual(2n * TXN_FEE)
    expect(creatorAfterRegister.minBalance).toEqual(creatorBeforeRegister.minBalance)
    expect(factoryAfterRegister.balance - factoryBefore.balance).toEqual(REGISTER_MBR)
    expect(factoryAfterRegister.minBalance - factoryBefore.minBalance).toEqual(REGISTER_MBR) // box MBR == deposit, by design
    expect(await isRegistered(factoryClient, campaignId, owner.addr.toString())).toBe(true)

    // Double registration fails.
    const creatorBeforeDouble = await accountInfo(creator.addr.toString())
    const secondPayment = await algorand.createTransaction.payment({
      sender: creator.addr.toString(),
      receiver: factoryAddress,
      amount: microAlgos(REGISTER_MBR),
    })
    await expect(
      factoryClient.send.call({
        method: 'register(uint64,pay)void',
        args: [campaignId, secondPayment],
        sender: creator.addr,
        appReferences: [campaignId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/campaign already registered/)
    expect(await accountInfo(creator.addr.toString())).toEqual(creatorBeforeDouble)

    // Unregister + delete in one atomic group: the deposit is returned and the campaign cannot remain live.
    const unregisterComposer = algorand.send.newGroup()
    unregisterComposer.addAppCallMethodCall({
      appId: factoryClient.appId,
      method: ABIMethod.fromSignature('unregister(uint64)void'),
      args: [campaignId],
      sender: creator.addr,
      appReferences: [campaignId],
      extraFee: microAlgos(TXN_FEE),
    })
    unregisterComposer.addAppCallMethodCall({
      appId: campaignId,
      method: ABIMethod.fromSignature('delete()void'),
      args: [],
      sender: creator.addr,
      onComplete: OnApplicationComplete.DeleteApplicationOC,
      appReferences: [vaultId],
      extraFee: microAlgos(2n * TXN_FEE),
    })
    await unregisterComposer.send({ suppressLog: true })
    expect(await isRegistered(factoryClient, campaignId, owner.addr.toString())).toBe(false)

    const factoryAfterUnregister = await accountInfo(factoryAddress)
    expect(factoryAfterUnregister.balance).toEqual(factoryAfterRegister.balance - REGISTER_MBR)
    // The registration box is gone: its MBR is released back to the account base.
    expect(factoryAfterUnregister.minBalance).toEqual(factoryBefore.minBalance)
  })

  test('an unregistered campaign cleans up through the same [unregister, delete] group', { timeout: 120_000 }, async () => {
    const owner = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { factoryClient, vaultId } = await deployFactory(owner.addr.toString())
    const campaignClient = await deployCampaign(creator.addr.toString(), vaultId)

    // No registration: unregister is a no-op, but the group still has to be shaped like the registered case.
    const composer = algorand.send.newGroup()
    composer.addAppCallMethodCall({
      appId: factoryClient.appId,
      method: ABIMethod.fromSignature('unregister(uint64)void'),
      args: [campaignClient.appId],
      sender: creator.addr,
      appReferences: [campaignClient.appId],
      extraFee: microAlgos(TXN_FEE),
    })
    composer.addAppCallMethodCall({
      appId: campaignClient.appId,
      method: ABIMethod.fromSignature('delete()void'),
      args: [],
      sender: creator.addr,
      onComplete: OnApplicationComplete.DeleteApplicationOC,
      appReferences: [vaultId],
      extraFee: microAlgos(2n * TXN_FEE),
    })
    await composer.send({ suppressLog: true })

    await expect(algorand.app.getById(campaignClient.appId)).rejects.toThrow()
    const stillRegistered = await factoryClient.send.call({
      method: 'isRegistered(uint64)bool',
      args: [campaignClient.appId],
      sender: owner.addr,
      suppressLog: true,
    })
    expect(Boolean(stillRegistered.return)).toBe(false)
  })

  test('an impostor copy of the Campaign contract cannot register', { timeout: 120_000 }, async () => {
    const owner = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { factoryClient, vaultId } = await deployFactory(owner.addr.toString())
    const campaignClient = await deployCampaign(creator.addr.toString(), vaultId)

    const hash = await campaignApprovalHash(campaignClient.appId)
    await factoryClient.send.call({
      method: 'setApprovalHash(byte[])void',
      args: [hash],
      sender: owner.addr,
      suppressLog: true,
    })

    // The Factory itself is an application, but not the official Campaign: its program hash does not match. The owner (the Factory's
    // creator) registers it, so the creator check passes and the program-hash check is what rejects.
    const payment = await algorand.createTransaction.payment({
      sender: owner.addr.toString(),
      receiver: factoryClient.appAddress,
      amount: microAlgos(REGISTER_MBR),
    })
    await expect(
      factoryClient.send.call({
        method: 'register(uint64,pay)void',
        args: [factoryClient.appId, payment],
        sender: owner.addr,
        appReferences: [factoryClient.appId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/not an official kasakame campaign/)
  })

  test('a campaign bound to a different vault cannot register', { timeout: 120_000 }, async () => {
    const owner = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { factoryClient } = await deployFactory(owner.addr.toString())
    // The Factory's own app is a real application, but not the official vault.
    const campaignClient = await deployCampaign(creator.addr.toString(), factoryClient.appId)

    const hash = await campaignApprovalHash(campaignClient.appId)
    await factoryClient.send.call({
      method: 'setApprovalHash(byte[])void',
      args: [hash],
      sender: owner.addr,
      suppressLog: true,
    })

    const payment = await algorand.createTransaction.payment({
      sender: creator.addr.toString(),
      receiver: factoryClient.appAddress,
      amount: microAlgos(REGISTER_MBR),
    })
    await expect(
      factoryClient.send.call({
        method: 'register(uint64,pay)void',
        args: [campaignClient.appId, payment],
        sender: creator.addr,
        appReferences: [campaignClient.appId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/campaign vault is not the official vault/)
  })

  test(
    'a non-creator cannot register someone else’s campaign, and registration is refused before the hash is configured',
    { timeout: 120_000 },
    async () => {
      const owner = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
      const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
      const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
      const { factoryClient, vaultId } = await deployFactory(owner.addr.toString())
      const campaignClient = await deployCampaign(creator.addr.toString(), vaultId)

      // No hash configured yet: registration is refused outright.
      const payment = await algorand.createTransaction.payment({
        sender: creator.addr.toString(),
        receiver: factoryClient.appAddress,
        amount: microAlgos(REGISTER_MBR),
      })
      await expect(
        factoryClient.send.call({
          method: 'register(uint64,pay)void',
          args: [campaignClient.appId, payment],
          sender: creator.addr,
          appReferences: [campaignClient.appId],
          suppressLog: true,
        }),
      ).rejects.toThrow(/official program hash not configured/)

      const hash = await campaignApprovalHash(campaignClient.appId)
      await factoryClient.send.call({
        method: 'setApprovalHash(byte[])void',
        args: [hash],
        sender: owner.addr,
        suppressLog: true,
      })

      // A stranger cannot register a campaign they did not create.
      const strangerPayment = await algorand.createTransaction.payment({
        sender: stranger.addr.toString(),
        receiver: factoryClient.appAddress,
        amount: microAlgos(REGISTER_MBR),
      })
      await expect(
        factoryClient.send.call({
          method: 'register(uint64,pay)void',
          args: [campaignClient.appId, strangerPayment],
          sender: stranger.addr,
          appReferences: [campaignClient.appId],
          suppressLog: true,
        }),
      ).rejects.toThrow(/only the campaign creator can register/)
    },
  )

  test('only the owner can set the official hash, and only the registered creator can unregister', { timeout: 120_000 }, async () => {
    const owner = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { factoryClient, vaultId } = await deployFactory(owner.addr.toString())
    const campaignClient = await deployCampaign(creator.addr.toString(), vaultId)

    // Non-owner cannot set the hash.
    await expect(
      factoryClient.send.call({
        method: 'setApprovalHash(byte[])void',
        args: [new Uint8Array(32)],
        sender: stranger.addr,
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the owner can set the program hash/)

    // Configure + register properly.
    const hash = await campaignApprovalHash(campaignClient.appId)
    await factoryClient.send.call({
      method: 'setApprovalHash(byte[])void',
      args: [hash],
      sender: owner.addr,
      suppressLog: true,
    })
    const payment = await algorand.createTransaction.payment({
      sender: creator.addr.toString(),
      receiver: factoryClient.appAddress,
      amount: microAlgos(REGISTER_MBR),
    })
    await factoryClient.send.call({
      method: 'register(uint64,pay)void',
      args: [campaignClient.appId, payment],
      sender: creator.addr,
      appReferences: [campaignClient.appId],
      suppressLog: true,
    })

    // A stranger cannot unregister the campaign (the deposit stays protected).
    await expect(
      factoryClient.send.call({
        method: 'unregister(uint64)void',
        args: [campaignClient.appId],
        sender: stranger.addr,
        appReferences: [campaignClient.appId],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the campaign creator can unregister/)

    // The registered creator can (unregister and delete must be one atomic group).
    const unregisterComposer = algorand.send.newGroup()
    unregisterComposer.addAppCallMethodCall({
      appId: factoryClient.appId,
      method: ABIMethod.fromSignature('unregister(uint64)void'),
      args: [campaignClient.appId],
      sender: creator.addr,
      appReferences: [campaignClient.appId],
      extraFee: microAlgos(TXN_FEE),
    })
    unregisterComposer.addAppCallMethodCall({
      appId: campaignClient.appId,
      method: ABIMethod.fromSignature('delete()void'),
      args: [],
      sender: creator.addr,
      onComplete: OnApplicationComplete.DeleteApplicationOC,
      appReferences: [vaultId],
      extraFee: microAlgos(2n * TXN_FEE),
    })
    await unregisterComposer.send({ suppressLog: true })
    expect(await isRegistered(factoryClient, campaignClient.appId, owner.addr.toString())).toBe(false)
  })
})
