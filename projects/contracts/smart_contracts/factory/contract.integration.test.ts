import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  REGISTER_MBR,
  accountInfo,
  campaignApprovalHash,
  deleteCampaign,
  deployCampaign,
  deployStack,
  isRegistered,
  registerCampaign,
  type ContractStack,
} from '../testing/localnet'

/**
 * LocalNet integration tests for the Factory registry: deploy the Factory, hash a real Campaign's approval program, and exercise
 * register/unregister/isRegistered, including the authorization and impostor guards.
 *
 * Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifacts exist.
 */

describe('Factory (localnet)', () => {
  const fixture = algorandFixture()
  let stack: ContractStack
  let algorand: ContractStack['algorand']

  beforeEach(async () => {
    stack = await deployStack(fixture, { ownerAlgo: 10, fundVault: 0n, configureCampaignHash: false })
    algorand = stack.algorand
  })

  test('register/isRegistered/unregister round trip with a real Campaign', { timeout: 120_000 }, async () => {
    const owner = stack.owner
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const factoryClient = stack.factory.client
    const factoryAddress = factoryClient.appAddress.toString()

    const campaignClient = await deployCampaign(stack, creator.addr.toString(), {
      goal: 1_000_000n,
      deadlineOffset: 3_600,
      title: 'Registrable',
      uri: 'ipfs://test',
      register: false,
    })
    const campaignId = campaignClient.appId

    // Configure the official hash from the real deployed program.
    const hash = await campaignApprovalHash(algorand, campaignId)
    await factoryClient.send.call({
      method: 'setApprovalHash(byte[])void',
      args: [hash],
      sender: owner.addr,
      suppressLog: true,
    })

    // Register: the creator pays the refundable deposit (the shared helper asserts the fee + MBR ledger).
    await registerCampaign(stack, campaignId, creator.addr.toString())
    expect(await isRegistered(factoryClient, campaignId, owner.addr.toString())).toBe(true)

    // Double registration fails.
    const creatorBeforeDouble = await accountInfo(algorand, creator.addr.toString())
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
    expect(await accountInfo(algorand, creator.addr.toString())).toEqual(creatorBeforeDouble)

    // Unregister + delete in one atomic group: the deposit is returned and the campaign cannot remain live.
    await deleteCampaign(stack, campaignId, creator.addr.toString())
    expect(await isRegistered(factoryClient, campaignId, owner.addr.toString())).toBe(false)
  })

  test('an unregistered campaign cleans up through the same [unregister, delete] group', { timeout: 120_000 }, async () => {
    const owner = stack.owner
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const factoryClient = stack.factory.client
    const campaignClient = await deployCampaign(stack, creator.addr.toString(), {
      goal: 1_000_000n,
      deadlineOffset: 3_600,
      title: 'Registrable',
      uri: 'ipfs://test',
      register: false,
    })

    // No registration: unregister is a no-op, but the group still has to be shaped like the registered case.
    await deleteCampaign(stack, campaignClient.appId, creator.addr.toString(), { registered: false })

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
    const owner = stack.owner
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const factoryClient = stack.factory.client
    const campaignClient = await deployCampaign(stack, creator.addr.toString(), {
      goal: 1_000_000n,
      deadlineOffset: 3_600,
      title: 'Registrable',
      uri: 'ipfs://test',
      register: false,
    })

    const hash = await campaignApprovalHash(algorand, campaignClient.appId)
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
    const owner = stack.owner
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const factoryClient = stack.factory.client
    // The Factory's own app is a real application, but not the official vault.
    const campaignClient = await deployCampaign(stack, creator.addr.toString(), {
      goal: 1_000_000n,
      deadlineOffset: 3_600,
      title: 'Registrable',
      uri: 'ipfs://test',
      register: false,
      vaultId: factoryClient.appId,
    })

    const hash = await campaignApprovalHash(algorand, campaignClient.appId)
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
      const owner = stack.owner
      const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
      const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
      const factoryClient = stack.factory.client
      const campaignClient = await deployCampaign(stack, creator.addr.toString(), {
        goal: 1_000_000n,
        deadlineOffset: 3_600,
        title: 'Registrable',
        uri: 'ipfs://test',
        register: false,
      })

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

      const hash = await campaignApprovalHash(algorand, campaignClient.appId)
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
    const owner = stack.owner
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const factoryClient = stack.factory.client
    const campaignClient = await deployCampaign(stack, creator.addr.toString(), {
      goal: 1_000_000n,
      deadlineOffset: 3_600,
      title: 'Registrable',
      uri: 'ipfs://test',
      register: false,
    })

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
    const hash = await campaignApprovalHash(algorand, campaignClient.appId)
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
    await deleteCampaign(stack, campaignClient.appId, creator.addr.toString())
    expect(await isRegistered(factoryClient, campaignClient.appId, owner.addr.toString())).toBe(false)
  })
})
