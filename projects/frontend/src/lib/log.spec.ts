import { afterEach, describe, expect, it, vi } from 'vitest'
import { frontendSdkLogger, logError } from './log'

describe('logError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('logs the context and the error through the development logger', () => {
    const consoleMock = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('boom')
    logError('pledge', failure)
    expect(consoleMock).toHaveBeenCalledWith('[kasakame:pledge]', { error: failure })
  })
})

describe('frontendSdkLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('writes every level to the matching console channel', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    frontendSdkLogger.debug('sdk.event', { a: 1 })
    frontendSdkLogger.info('sdk.event', { a: 1 })
    frontendSdkLogger.warn('sdk.event', { a: 1 })
    frontendSdkLogger.error('sdk.event', { a: 1 })

    expect(debug).toHaveBeenCalledWith('[kasakame:sdk.event]', { a: 1 })
    expect(info).toHaveBeenCalledWith('[kasakame:sdk.event]', { a: 1 })
    expect(warn).toHaveBeenCalledWith('[kasakame:sdk.event]', { a: 1 })
    expect(error).toHaveBeenCalledWith('[kasakame:sdk.event]', { a: 1 })
  })

  it('honors VITE_LOG_LEVEL in development', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_LOG_LEVEL', 'warn')
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const development = await import('./log')
    development.frontendSdkLogger.debug('sdk.event')
    development.frontendSdkLogger.info('sdk.event')
    development.frontendSdkLogger.warn('sdk.event')

    expect(debug).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[kasakame:sdk.event]', undefined)
  })

  it('defaults an unknown VITE_LOG_LEVEL to debug', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_LOG_LEVEL', 'trace')
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})

    const development = await import('./log')
    development.frontendSdkLogger.debug('sdk.event')

    expect(debug).toHaveBeenCalledWith('[kasakame:sdk.event]', undefined)
  })

  it('stays silent in a production build', async () => {
    vi.resetModules()
    vi.stubEnv('DEV', false)
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const production = await import('./log')
    production.frontendSdkLogger.debug('sdk.event')
    production.frontendSdkLogger.info('sdk.event')
    production.frontendSdkLogger.warn('sdk.event')
    production.frontendSdkLogger.error('sdk.event')

    expect(debug).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})
