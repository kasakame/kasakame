import type { SdkLogger } from '../../src/index.js'
import { createLevelLogger } from '../../src/index.js'

/**
 * The SDK logger for a test run, driven by `KASAKAME_TEST_LOG`; undefined keeps it silent.
 *
 * @returns A level-filtered stderr logger, or undefined for no-op.
 */
export function testSdkLogger(): SdkLogger | undefined {
  const level = process.env.KASAKAME_TEST_LOG
  if (level !== 'info' && level !== 'debug') return undefined
  return createLevelLogger(level, {
    debug: (event, context) => {
      console.error(`[sdk:debug] ${event}`, context ?? '')
    },
    info: (event, context) => {
      console.error(`[sdk:info] ${event}`, context ?? '')
    },
    warn: (event, context) => {
      console.error(`[sdk:warn] ${event}`, context ?? '')
    },
    error: (event, context) => {
      console.error(`[sdk:error] ${event}`, context ?? '')
    },
  })
}
