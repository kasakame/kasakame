import { describe, expect, it } from 'vitest'
import { DEFAULT_REFUND_WINDOW_SECONDS, MAX_REFUND_WINDOW_SECONDS, parseRefundWindow } from './deploy-config'

describe('parseRefundWindow', () => {
  it('defaults to 730 days when unset', () => {
    expect(parseRefundWindow(undefined)).toBe(DEFAULT_REFUND_WINDOW_SECONDS)
    expect(parseRefundWindow('')).toBe(DEFAULT_REFUND_WINDOW_SECONDS)
  })

  it('accepts a positive value within the cap', () => {
    expect(parseRefundWindow('3600')).toBe(3600n)
    expect(parseRefundWindow(MAX_REFUND_WINDOW_SECONDS.toString())).toBe(MAX_REFUND_WINDOW_SECONDS)
  })

  it('rejects zero and negative values', () => {
    expect(() => parseRefundWindow('0')).toThrow('between 1 and')
    expect(() => parseRefundWindow('-1')).toThrow('between 1 and')
  })

  it('rejects values above the cap', () => {
    expect(() => parseRefundWindow((MAX_REFUND_WINDOW_SECONDS + 1n).toString())).toThrow('between 1 and')
  })

  it('rejects non-integer values', () => {
    expect(() => parseRefundWindow('1.5')).toThrow('integer number of seconds')
    expect(() => parseRefundWindow('soon')).toThrow('integer number of seconds')
  })
})
