import { describe, expect, it } from 'vitest'
import { FEE, SELECTORS, pledgeExtraFee, selectorOf, spendExtraFee, spendFee } from './localnet'

/**
 * Pins the shared helper formulas and selectors. These mirror the contract and SDK; a drift here (or in the contract)
 * fails this test, which keeps the LocalNet suites from silently over/under-funding a group.
 */
describe('contract LocalNet helpers', () => {
  it('computes pledge OpUp takes from the frontier width', () => {
    expect(pledgeExtraFee(0)).toEqual(0n)
    expect(pledgeExtraFee(1)).toEqual(0n)
    expect(pledgeExtraFee(2)).toEqual(0n)
    expect(pledgeExtraFee(3)).toEqual(FEE)
    expect(pledgeExtraFee(7)).toEqual(2n * FEE)
    expect(pledgeExtraFee(19)).toEqual(6n * FEE)
  })

  it('computes spend OpUp takes from the path shape and payout inners', () => {
    const smallPath = { siblings: [], top: null, lower: ['00'] }
    expect(spendExtraFee(smallPath, 2)).toEqual(3n * FEE)
    expect(spendExtraFee(smallPath, 1)).toEqual(2n * FEE)
    expect(spendFee(smallPath, 2)).toEqual(4n * FEE)
    expect(spendFee(smallPath, 1)).toEqual(3n * FEE)

    // The 2^19 - 1 cap, leaf 0: r = c = 18, so the campaign path fits exactly 16 inner transactions.
    const capPath = { siblings: Array<string>(18).fill('00'), top: null, lower: Array<string>(18).fill('00') }
    expect(spendExtraFee(capPath, 2)).toEqual(16n * FEE)
    expect(spendExtraFee(capPath, 1)).toEqual(15n * FEE)
  })

  it('pins the embedded selectors', () => {
    expect(SELECTORS).toEqual({
      payBack: 'b0e0eedf',
      payClaim: 'f8c4e0cb',
      settle: '09200848',
      notifyDelete: '87060e1d',
      credit: '8027a4bb',
      pledge: 'a4030bd2',
      delete: '24378d3c',
      isRegistered: '716a3d0e',
    })
    expect(selectorOf('payBack(uint64,address,uint64)void')).toEqual(SELECTORS.payBack)
  })
})
