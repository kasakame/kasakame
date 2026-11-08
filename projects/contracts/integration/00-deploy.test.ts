import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
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
  type ContractStack,
} from './support/localnet'

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
})
