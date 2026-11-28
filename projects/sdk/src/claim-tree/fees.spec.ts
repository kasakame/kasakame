import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MAX_TREE_SIZE, pledgeOpUpIterations, refundOpUpIterations } from './index.js'

describe('fee sizing', () => {
  it('computes pledge OpUp iterations from the tree size', () => {
    expect(pledgeOpUpIterations(0n)).toEqual(0)
    expect(pledgeOpUpIterations(4n)).toEqual(0)
    expect(pledgeOpUpIterations(15n)).toEqual(1)
    expect(pledgeOpUpIterations(1023n)).toEqual(3)
    expect(pledgeOpUpIterations(MAX_TREE_SIZE)).toEqual(6)
  })

  it('computes spend OpUp iterations from the zero-headroom path bound', () => {
    expect(refundOpUpIterations(1n, 0n)).toEqual(2)
    expect(refundOpUpIterations(4n, 0n)).toEqual(2)
    expect(refundOpUpIterations(15n, 0n)).toEqual(4)
    expect(refundOpUpIterations(47n, 0n)).toEqual(5)
    expect(refundOpUpIterations(100n, 0n)).toEqual(5)
    expect(refundOpUpIterations(100n, 64n)).toEqual(4)
    expect(refundOpUpIterations(1_024n, 0n)).toEqual(5)
    expect(refundOpUpIterations(MAX_TREE_SIZE, 0n)).toEqual(15)
  })

  it('pins the supported tree size to 524,287', () => {
    expect(MAX_TREE_SIZE).toEqual(524_287n)
  })

  it('uses the shared contract budget constants', () => {
    const contracts = fileURLToPath(new URL('../../../contracts/smart_contracts', import.meta.url))
    const campaign = fs.readFileSync(path.join(contracts, 'campaign/contract.algo.ts'), 'utf8')
    const vault = fs.readFileSync(path.join(contracts, 'claimsvault/contract.algo.ts'), 'utf8')
    const registry = fs.readFileSync(path.join(contracts, 'registry/contract.algo.ts'), 'utf8')
    for (const source of [campaign, vault, registry]) {
      expect(source).toContain('@kasakame/constants/source')
      expect(source).toContain('Uint64(MAX_TREE_SIZE)')
      expect(source).not.toContain('524_287')
      expect(source).not.toContain('_VALUE')
    }
    expect(campaign).toContain('PLEDGE_PEAK_COST')
    expect(campaign).toContain('PLEDGE_BASE_COST')
    for (const source of [campaign, vault]) {
      expect(source).toContain('SPEND_ELEMENT_COST')
      expect(source).toContain('SPEND_BASE_COST')
      expect(source).not.toContain('requiredOps')
    }
  })
})
