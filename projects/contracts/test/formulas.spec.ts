import { FEE_MICRO_ALGOS } from '@kasakame/constants'
import { selectorOf } from '@kasakame/utils/testing'
import { describe, expect, it } from 'vitest'
import { SELECTORS, pledgeExtraFee, spendExtraFee, spendFee } from './helpers/campaign'

/**
 * Pins the shared helper formulas and selectors. The spend fee assumes no prelude budget survives, which overfunds
 * the OpUp takes at worst by one fee and never underfunds a group.
 */
describe('contract LocalNet helpers', () => {
  it('computes pledge OpUp takes from the frontier width', () => {
    expect(pledgeExtraFee(0)).toEqual(0n)
    expect(pledgeExtraFee(1)).toEqual(0n)
    expect(pledgeExtraFee(2)).toEqual(0n)
    expect(pledgeExtraFee(3)).toEqual(FEE_MICRO_ALGOS)
    expect(pledgeExtraFee(7)).toEqual(2n * FEE_MICRO_ALGOS)
    expect(pledgeExtraFee(19)).toEqual(6n * FEE_MICRO_ALGOS)
  })

  it('computes spend OpUp takes from the path shape and payout inners', () => {
    const smallPath = { siblings: [], top: null, lower: ['00'] }
    expect(spendExtraFee(smallPath, 2)).toEqual(4n * FEE_MICRO_ALGOS)
    expect(spendExtraFee(smallPath, 1)).toEqual(3n * FEE_MICRO_ALGOS)
    expect(spendFee(smallPath, 2)).toEqual(5n * FEE_MICRO_ALGOS)
    expect(spendFee(smallPath, 1)).toEqual(4n * FEE_MICRO_ALGOS)

    // The 2^19 - 1 cap, leaf 0: r = c = 18. The zero-headroom fee funds 15 takes; the group pays for them even
    // though the contract requests 14, so 2 payouts + 15 = 17 fees on the campaign path.
    const capPath = { siblings: Array<string>(18).fill('00'), top: null, lower: Array<string>(18).fill('00') }
    expect(spendExtraFee(capPath, 2)).toEqual(17n * FEE_MICRO_ALGOS)
    expect(spendExtraFee(capPath, 1)).toEqual(16n * FEE_MICRO_ALGOS)
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
