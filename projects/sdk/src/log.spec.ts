import { afterEach, describe, expect, it, vi } from 'vitest'
import { sdkLogger, setSdkLogger } from './log.js'

afterEach(() => {
  setSdkLogger(undefined)
})

describe('sdkLogger', () => {
  it('defaults to a no-op logger', () => {
    const logger = sdkLogger()

    expect(() => {
      logger.debug('event')
      logger.info('event')
      logger.warn('event')
      logger.error('event')
    }).not.toThrow()
  })

  it('returns the configured logger', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    setSdkLogger(logger)

    expect(sdkLogger()).toBe(logger)
  })
})
