import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { specProgramHash } from '@kasakame/utils'
import { accountInfo, minBalanceOf } from '@kasakame/utils/testing'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  APP_BASE,
  DEPLOY_FUNDING,
  REGISTRY_MBR,
  SELECTORS,
  TEST_VAULT_WINDOW,
  VAULT_MBR,
  deleteCampaign,
  deployCampaign,
  deployStack,
  registerCampaign,
  type ContractStack,
} from './utils'

/**
 * 00 - deployment and wiring.
 *
 * Proves the ownerless Registry and ClaimsVault deploy with the immutable campaign/vault hashes and vault configuration,
 * that the vault binds permissionlessly and only once, and that register/unregister still round-trip after binding.
 * `beforeAll` deploys the stack; the guard tests deploy their own isolated stacks.
 */
describe('00 deployment and wiring', () => {
  const fixture = algorandFixture()
  let stack: ContractStack

  beforeAll(async () => {
    stack = await deployStack(fixture)
  })

  test('CON-001 Registry is ownerless and bound to the official vault', { tags: ['smoke', 'always'] }, async () => {
    const registry = stack.registry.client
    expect(stack.registry.appId).toBeGreaterThan(0n)

    const globalKeys = Object.keys(stack.specs.registry.state.keys.global)
    expect(globalKeys).not.toContain('owner')
    expect(globalKeys).not.toContain('pendingApprovalHash')
    expect(globalKeys).not.toContain('approvalHashEligibleAt')
    expect(stack.specs.registry.methods.map((method) => method.name)).not.toContain('setApprovalHash')
    expect(stack.specs.registry.methods.map((method) => method.name)).not.toContain('setVault')

    expect(await registry.state.global.getValue('vault')).toEqual(stack.vault.appId)
    expect(Buffer.from((await registry.state.global.getValue('campaignProgramHash')) as Uint8Array)).toEqual(
      Buffer.from(specProgramHash(stack.specs.campaign, 'Campaign.arc56.json')),
    )
    expect(Buffer.from((await registry.state.global.getValue('vaultProgramHash')) as Uint8Array)).toEqual(
      Buffer.from(specProgramHash(stack.specs.vault, 'ClaimsVault.arc56.json')),
    )
    expect(await registry.state.global.getValue('expectedSweepTarget')).toEqual(stack.sweeperAddress)
    expect(await registry.state.global.getValue('expectedRefundWindow')).toEqual(TEST_VAULT_WINDOW)

    expect(await accountInfo(stack.algorand, stack.registry.address)).toEqual({
      balance: DEPLOY_FUNDING,
      minBalance: APP_BASE,
    })
    expect(await minBalanceOf(stack.algorand, stack.ownerAddress)).toBeGreaterThanOrEqual(REGISTRY_MBR + VAULT_MBR)
  })

  test('CON-002 ClaimsVault records the Registry, sweep target, and window', { tags: ['smoke', 'always'] }, async () => {
    const vault = stack.vault.client
    expect(stack.vault.appId).toBeGreaterThan(0n)
    expect(await vault.state.global.getValue('registry')).toEqual(stack.registry.appId)
    expect(await vault.state.global.getValue('sweepTarget')).toEqual(stack.sweeperAddress)
    expect(await vault.state.global.getValue('refundWindow')).toEqual(TEST_VAULT_WINDOW)
    expect(await accountInfo(stack.algorand, stack.vault.address)).toEqual({
      balance: DEPLOY_FUNDING,
      minBalance: APP_BASE,
    })
  })

  test('CON-003 contracts embed the expected inner-call selectors', { tags: ['smoke', 'always'] }, () => {
    const campaignApproval = fs.readFileSync(
      path.resolve(__dirname, '../smart_contracts/artifacts/campaign/Campaign.approval.teal'),
      'utf8',
    )
    for (const selector of [SELECTORS.payBack, SELECTORS.payClaim, SELECTORS.settle, SELECTORS.notifyDelete, SELECTORS.credit]) {
      expect(campaignApproval).toContain(selector)
    }

    const vaultApproval = fs.readFileSync(
      path.resolve(__dirname, '../smart_contracts/artifacts/claimsvault/ClaimsVault.approval.teal'),
      'utf8',
    )
    expect(vaultApproval).toContain(SELECTORS.isRegistered)
    expect(vaultApproval).toContain(SELECTORS.pledge)

    const registryApproval = fs.readFileSync(
      path.resolve(__dirname, '../smart_contracts/artifacts/registry/Registry.approval.teal'),
      'utf8',
    )
    expect(registryApproval).toContain(SELECTORS.delete)
  })

  test('CON-004 bindVault rejects a second bind, a foreign registry, and wrong config', { tags: ['bad', 'always'] }, async () => {
    const bound = await deployStack(fixture)
    await expect(
      bound.registry.client.send.call({
        method: 'bindVault(uint64)void',
        args: [bound.vault.appId],
        sender: bound.ownerAddress,
        appReferences: [bound.vault.appId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/vault already bound/)

    const foreign = await deployStack(fixture, { bindVault: false })
    await expect(
      foreign.registry.client.send.call({
        method: 'bindVault(uint64)void',
        args: [bound.vault.appId],
        sender: foreign.ownerAddress,
        appReferences: [bound.vault.appId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/vault is not bound to this registry/)

    const wrongProgram = await deployStack(fixture, {
      bindVault: false,
      vaultProgramHash: specProgramHash(bound.specs.campaign, 'Campaign.arc56.json'),
    })
    await expect(
      wrongProgram.registry.client.send.call({
        method: 'bindVault(uint64)void',
        args: [wrongProgram.vault.appId],
        sender: wrongProgram.ownerAddress,
        appReferences: [wrongProgram.vault.appId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/not the official vault program/)
    expect(await wrongProgram.registry.client.state.global.getValue('vault')).toEqual(0n)

    const otherSweep = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const wrongSweep = await deployStack(fixture, {
      bindVault: false,
      registrySweepTarget: otherSweep.addr.toString(),
    })
    await expect(
      wrongSweep.registry.client.send.call({
        method: 'bindVault(uint64)void',
        args: [wrongSweep.vault.appId],
        sender: wrongSweep.ownerAddress,
        appReferences: [wrongSweep.vault.appId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/vault sweep target mismatch/)

    const wrongWindow = await deployStack(fixture, {
      bindVault: false,
      registryWindowSeconds: TEST_VAULT_WINDOW + 1n,
    })
    await expect(
      wrongWindow.registry.client.send.call({
        method: 'bindVault(uint64)void',
        args: [wrongWindow.vault.appId],
        sender: wrongWindow.ownerAddress,
        appReferences: [wrongWindow.vault.appId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/vault refund window mismatch/)
  })

  test('CON-005 bindVault is permissionless', { tags: ['smoke', 'always'] }, async () => {
    const local = await deployStack(fixture, { bindVault: false })
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })

    await local.registry.client.send.call({
      method: 'bindVault(uint64)void',
      args: [local.vault.appId],
      sender: stranger.addr,
      appReferences: [local.vault.appId],
      suppressLog: true,
    })
    expect(await local.registry.client.state.global.getValue('vault')).toEqual(local.vault.appId)
  })

  test('CON-006 register and unregister round-trip after binding', { tags: ['smoke', 'always'] }, async () => {
    const local = await deployStack(fixture)
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const campaign = await deployCampaign(local, creator.addr.toString(), { register: false })

    const registeredBox = () => local.registry.client.state.box.getMapValue('registered', campaign.appId).catch(() => undefined)

    await registerCampaign(local, campaign.appId, creator.addr.toString())
    expect(await registeredBox()).toEqual(creator.addr.toString())

    await deleteCampaign(local, campaign.appId, creator.addr.toString())
    expect(await registeredBox()).toBeUndefined()
  })
})
