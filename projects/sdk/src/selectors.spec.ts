import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import algosdk from 'algosdk'
import { describe, expect, it } from 'vitest'
import { APP_SPEC as campaignSpec } from './generated/CampaignClient.js'
import { APP_SPEC as vaultSpec } from './generated/ClaimsVaultClient.js'
import { SELECTOR_CANCEL, SELECTOR_PLEDGE, SELECTOR_REFUND, SELECTOR_VAULT_REFUND } from './selectors.js'

/**
 * Compute an ARC-4 selector from the generated client's embedded ARC-56 method, not from a hand-written signature.
 *
 * @param spec Generated ARC-56 contract spec.
 * @param name Method name.
 * @returns The 4-byte selector as hex.
 */
function selectorFor(spec: Arc56Contract, name: string): string {
  const method = spec.methods.find((candidate) => candidate.name === name)
  if (!method) throw new Error(`missing ${name} in ${spec.name}`)
  const abiMethod = new algosdk.ABIMethod({
    name: method.name,
    args: method.args.map((arg) => ({ type: arg.type })),
    returns: { type: method.returns.type },
  })
  return Buffer.from(abiMethod.getSelector()).toString('hex')
}

describe('tree selectors', () => {
  it('match the generated ARC-56 method signatures', () => {
    expect(selectorFor(campaignSpec, 'pledge')).toBe(SELECTOR_PLEDGE)
    expect(selectorFor(campaignSpec, 'cancelPledge')).toBe(SELECTOR_CANCEL)
    expect(selectorFor(campaignSpec, 'refund')).toBe(SELECTOR_REFUND)
    expect(selectorFor(vaultSpec, 'refund')).toBe(SELECTOR_VAULT_REFUND)
  })
})
