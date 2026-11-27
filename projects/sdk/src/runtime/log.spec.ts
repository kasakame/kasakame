import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLevelLogger, sdkLogger, setSdkLogger } from './log.js'

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

describe('createLevelLogger', () => {
  it('drops events below the minimum level', () => {
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const logger = createLevelLogger('warn', sink)

    logger.debug('event', { a: 1 })
    logger.info('event', { a: 1 })
    logger.warn('event', { a: 1 })
    logger.error('event', { a: 1 })

    expect(sink.debug).not.toHaveBeenCalled()
    expect(sink.info).not.toHaveBeenCalled()
    expect(sink.warn).toHaveBeenCalledWith('event', { a: 1 })
    expect(sink.error).toHaveBeenCalledWith('event', { a: 1 })
  })

  it('passes every level at debug', () => {
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const logger = createLevelLogger('debug', sink)

    logger.debug('event')
    logger.info('event')
    logger.warn('event')
    logger.error('event')

    expect(sink.debug).toHaveBeenCalledOnce()
    expect(sink.info).toHaveBeenCalledOnce()
    expect(sink.warn).toHaveBeenCalledOnce()
    expect(sink.error).toHaveBeenCalledOnce()
  })

  it('prints only errors at the error level', () => {
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const logger = createLevelLogger('error', sink)

    logger.warn('event')
    logger.error('event')

    expect(sink.warn).not.toHaveBeenCalled()
    expect(sink.error).toHaveBeenCalledOnce()
  })
})
