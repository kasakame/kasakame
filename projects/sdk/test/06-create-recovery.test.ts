import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO, REGISTER_DEPOSIT_MICRO_ALGOS } from '@kasakame/constants'
import { accountInfo } from '@kasakame/utils/testing'
import { describe, expect, test } from 'vitest'
import { RegistryClient } from '../src/generated/RegistryClient.js'
import {
  createCampaign,
  deleteCampaign,
  enumerateCampaigns,
  fetchChainTimestamp,
  fetchVaultBox,
  isRegistered,
  registerCampaign,
} from '../src/index.js'
import { headerOf, session, setupSdkStack } from './utils/index.js'

describe('SDK create recovery (localnet)', () => {
  const fixture = algorandFixture()

  test('SDK-060 unbound Registry → registered: false → bind → register retry → delete', { tags: ['happy', 'always'] }, async () => {
    const stack = await setupSdkStack(fixture, { bindVault: false })
    const creator = await session(fixture, 50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const creatorBeforeCreate = await accountInfo(stack.algorand, creator.address)
    const registryBefore = await accountInfo(stack.algorand, stack.registryAddress)

    const { appId, registered, registerError } = await createCampaign(
      creator,
      'SDK create recovery',
      'ipfs://sdk-create-recovery',
      10n * MICRO_ALGOS_PER_ALGO,
      deadline,
    )
    expect(registered).toBe(false)
    expect(registerError).toMatch(/official vault not configured/)
    expect(await isRegistered(appId)).toBe(false)
    expect(await fetchVaultBox(appId)).toBeUndefined()
    expect((await headerOf(appId)).title).toEqual('SDK create recovery')
    const creatorAfterCreate = await accountInfo(stack.algorand, creator.address)
    const campaignMbr = creatorAfterCreate.minBalance - creatorBeforeCreate.minBalance
    expect(campaignMbr).toBeGreaterThan(0n)

    const registry = new RegistryClient({
      algorand: stack.algorand,
      appId: stack.registryAppId,
      defaultSender: creator.address,
      defaultSigner: creator.signer,
    })
    await registry.send.bindVault({ args: [stack.vaultAppId], appReferences: [stack.vaultAppId] })
    await registerCampaign(appId, creator)
    expect(await isRegistered(appId)).toBe(true)
    const registryAfterRegister = await accountInfo(stack.algorand, stack.registryAddress)
    expect(registryAfterRegister.minBalance - registryBefore.minBalance).toEqual(REGISTER_DEPOSIT_MICRO_ALGOS)
    expect(registryAfterRegister.balance - registryBefore.balance).toEqual(REGISTER_DEPOSIT_MICRO_ALGOS)

    // A retry after the registration landed is a no-op, not an error.
    await registerCampaign(appId, creator)
    expect(await isRegistered(appId)).toBe(true)

    const creatorBeforeDelete = await accountInfo(stack.algorand, creator.address)
    await deleteCampaign(appId, creator)
    const creatorAfterDelete = await accountInfo(stack.algorand, creator.address)
    const registryAfterDelete = await accountInfo(stack.algorand, stack.registryAddress)
    expect(creatorBeforeDelete.minBalance - creatorAfterDelete.minBalance).toEqual(campaignMbr)
    expect(creatorAfterDelete.balance - creatorBeforeDelete.balance).toEqual(REGISTER_DEPOSIT_MICRO_ALGOS - 5n * stack.minFee)
    expect(registryAfterDelete).toEqual(registryBefore)
    expect(await isRegistered(appId)).toBe(false)
    await expect(stack.algorand.app.getById(appId)).rejects.toThrow()
  })

  test('SDK-061 mismatched Registry program hash fails before creating an app', { tags: ['bad', 'always'] }, async () => {
    const stack = await setupSdkStack(fixture, { campaignProgramHash: new Uint8Array(32) })
    const creator = await session(fixture, 50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const before = await stack.algorand.account.getInformation(creator.address)

    await expect(createCampaign(creator, 'SDK wrong hash', 'ipfs://sdk-wrong-hash', MICRO_ALGOS_PER_ALGO, deadline)).rejects.toThrow(
      /the Registry expects Campaign program hash/,
    )

    const after = await stack.algorand.account.getInformation(creator.address)
    expect(after.totalCreatedApps).toEqual(before.totalCreatedApps)
    expect(await enumerateCampaigns()).toEqual(new Set())
  })
})
