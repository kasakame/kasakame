import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { APPROVAL_HASH_DELAY } from '../smart_contracts/factory/contract.algo'
import { programHash } from '../smart_contracts/program-hash'
import {
  APP_BASE,
  DEPLOY_FUNDING,
  FACTORY_MBR,
  SELECTORS,
  TEST_VAULT_WINDOW,
  VAULT_MBR,
  accountInfo,
  deployStack,
  minBalanceOf,
  specProgramHash,
  type ContractStack,
} from './support/localnet'

const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'

/**
 * 00 - deployment and wiring.
 *
 * Proves the Factory and ClaimsVault deploy, are configured with the official program hashes, are bound to each other,
 * and carry the expected embedded selectors. `beforeAll` deploys the stack; the tests assert the resulting state.
 */
describe('00 deployment and wiring', () => {
  const fixture = algorandFixture()
  let stack: ContractStack

  beforeAll(async () => {
    stack = await deployStack(fixture)
  })

  test('CON-001 Factory is owned and bound to the official vault', { tags: ['smoke', 'always'] }, async () => {
    const factory = stack.factory.client
    expect(stack.factory.appId).toBeGreaterThan(0n)
    expect(await factory.state.global.getValue('owner')).toEqual(stack.ownerAddress)
    expect(await factory.state.global.getValue('vault')).toEqual(stack.vault.appId)

    const approvalHash = (await factory.state.global.getValue('approvalHash')) as Uint8Array
    const vaultHash = (await factory.state.global.getValue('vaultApprovalHash')) as Uint8Array
    expect(approvalHash.length).toEqual(32)
    expect(vaultHash.length).toEqual(32)

    const campaignByteCode = stack.specs.campaign.byteCode
    if (campaignByteCode === undefined) throw new Error('Campaign.arc56.json has no byteCode; run `npm run build` first.')
    expect(Buffer.from(approvalHash)).toEqual(
      Buffer.from(programHash(Buffer.from(campaignByteCode.approval, 'base64'), Buffer.from(campaignByteCode.clear, 'base64'))),
    )

    expect(await accountInfo(stack.algorand, stack.factory.address)).toEqual({
      balance: DEPLOY_FUNDING,
      minBalance: APP_BASE,
    })
    expect(await minBalanceOf(stack.algorand, stack.ownerAddress)).toBeGreaterThanOrEqual(FACTORY_MBR + VAULT_MBR)
  })

  test('CON-002 ClaimsVault records the Factory, sweep target, and window', { tags: ['smoke', 'always'] }, async () => {
    const vault = stack.vault.client
    expect(stack.vault.appId).toBeGreaterThan(0n)
    expect(await vault.state.global.getValue('factory')).toEqual(stack.factory.appId)
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

    const factoryApproval = fs.readFileSync(path.resolve(__dirname, '../smart_contracts/artifacts/factory/Factory.approval.teal'), 'utf8')
    expect(factoryApproval).toContain(SELECTORS.delete)
  })

  test('CON-004 Factory hash timelock: propose, reject early apply, cancel', { tags: ['bad', 'always'] }, async () => {
    const local = await deployStack(fixture)
    const factory = local.factory.client
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const next = new Uint8Array(32).fill(0x11)
    const active = (await factory.state.global.getValue('approvalHash')) as Uint8Array

    await expect(
      factory.send.call({
        method: 'proposeApprovalHash(byte[])void',
        args: [next],
        sender: stranger.addr,
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the owner can propose the program hash/)
    await expect(
      factory.send.call({
        method: 'proposeApprovalHash(byte[])void',
        args: [new Uint8Array(31)],
        sender: local.ownerAddress,
        suppressLog: true,
      }),
    ).rejects.toThrow(/program hash must be 32 bytes/)

    await factory.send.call({ method: 'proposeApprovalHash(byte[])void', args: [next], sender: local.ownerAddress, suppressLog: true })
    expect(Buffer.from((await factory.state.global.getValue('pendingApprovalHash')) as Uint8Array)).toEqual(Buffer.from(next))
    const lastRound = (await local.algorand.client.algod.status().do()).lastRound
    expect(await factory.state.global.getValue('approvalHashEligibleAt')).toEqual(lastRound + BigInt(APPROVAL_HASH_DELAY))

    await expect(
      factory.send.call({ method: 'applyApprovalHash()void', args: [], sender: local.ownerAddress, suppressLog: true }),
    ).rejects.toThrow(/program hash timelock not elapsed/)
    expect(Buffer.from((await factory.state.global.getValue('approvalHash')) as Uint8Array)).toEqual(Buffer.from(active))

    await factory.send.call({ method: 'cancelApprovalHash()void', args: [], sender: local.ownerAddress, suppressLog: true })
    expect(((await factory.state.global.getValue('pendingApprovalHash')) as Uint8Array).length).toEqual(0)
    expect(await factory.state.global.getValue('approvalHashEligibleAt')).toEqual(0n)
    await expect(
      factory.send.call({ method: 'applyApprovalHash()void', args: [], sender: local.ownerAddress, suppressLog: true }),
    ).rejects.toThrow(/no pending program hash/)
  })

  test('CON-005 Factory ownership transfer and renounce', { tags: ['bad', 'always'] }, async () => {
    const local = await deployStack(fixture)
    const factory = local.factory.client
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const newOwner = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })

    await expect(
      factory.send.call({
        method: 'transferOwnership(address)void',
        args: [newOwner.addr],
        sender: stranger.addr,
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the owner can transfer ownership/)
    await expect(
      factory.send.call({ method: 'transferOwnership(address)void', args: [ZERO_ADDRESS], sender: local.ownerAddress, suppressLog: true }),
    ).rejects.toThrow(/new owner must not be zero/)

    await factory.send.call({
      method: 'transferOwnership(address)void',
      args: [newOwner.addr],
      sender: local.ownerAddress,
      suppressLog: true,
    })
    expect(await factory.state.global.getValue('owner')).toEqual(newOwner.addr.toString())
    await expect(
      factory.send.call({
        method: 'setApprovalHash(byte[])void',
        args: [new Uint8Array(32)],
        sender: local.ownerAddress,
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the owner can set the program hash/)
    await factory.send.call({
      method: 'proposeApprovalHash(byte[])void',
      args: [new Uint8Array(32).fill(0x22)],
      sender: newOwner.addr,
      suppressLog: true,
    })
    await factory.send.call({ method: 'cancelApprovalHash()void', args: [], sender: newOwner.addr, suppressLog: true })

    await expect(
      factory.send.call({ method: 'renounceOwnership()void', args: [], sender: local.ownerAddress, suppressLog: true }),
    ).rejects.toThrow(/only the owner can renounce ownership/)
    await factory.send.call({ method: 'renounceOwnership()void', args: [], sender: newOwner.addr, suppressLog: true })
    expect(await factory.state.global.getValue('owner')).toEqual(ZERO_ADDRESS)
    await expect(
      factory.send.call({
        method: 'proposeApprovalHash(byte[])void',
        args: [new Uint8Array(32)],
        sender: newOwner.addr,
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the owner can propose the program hash/)
  })

  test('CON-006 Factory setVault guards: wrong factory, wrong program, already set', { tags: ['bad', 'always'] }, async () => {
    const bound = await deployStack(fixture)
    await expect(
      bound.factory.client.send.call({
        method: 'setVault(uint64)void',
        args: [bound.vault.appId],
        sender: bound.ownerAddress,
        appReferences: [bound.vault.appId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/vault already set/)
    await expect(
      bound.factory.client.send.call({
        method: 'setVaultApprovalHash(byte[])void',
        args: [new Uint8Array(32)],
        sender: bound.ownerAddress,
        suppressLog: true,
      }),
    ).rejects.toThrow(/vault already set/)

    const local = await deployStack(fixture, { bindVault: false })
    const factory = local.factory.client
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })

    await expect(
      factory.send.call({
        method: 'setVault(uint64)void',
        args: [bound.vault.appId],
        sender: local.ownerAddress,
        appReferences: [bound.vault.appId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/vault is not bound to this factory/)
    await expect(
      factory.send.call({
        method: 'setVaultApprovalHash(byte[])void',
        args: [new Uint8Array(32)],
        sender: stranger.addr,
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the owner can set the vault hash/)

    await factory.send.call({
      method: 'setVaultApprovalHash(byte[])void',
      args: [new Uint8Array(32).fill(0x33)],
      sender: local.ownerAddress,
      suppressLog: true,
    })
    await expect(
      factory.send.call({
        method: 'setVault(uint64)void',
        args: [local.vault.appId],
        sender: local.ownerAddress,
        appReferences: [local.vault.appId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/not the official vault program/)
    expect(await factory.state.global.getValue('vault')).toEqual(0n)

    await factory.send.call({
      method: 'setVaultApprovalHash(byte[])void',
      args: [specProgramHash(local.specs.vault, 'ClaimsVault.arc56.json')],
      sender: local.ownerAddress,
      suppressLog: true,
    })
    await factory.send.call({
      method: 'setVault(uint64)void',
      args: [local.vault.appId],
      sender: local.ownerAddress,
      appReferences: [local.vault.appId],
      suppressLog: true,
    })
    expect(await factory.state.global.getValue('vault')).toEqual(local.vault.appId)
  })
})
