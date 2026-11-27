import type { SdkLogger, SdkLogLevel } from '@kasakame/sdk'
import { createLevelLogger } from '@kasakame/sdk'

const DEV_LOGGER: SdkLogger = {
  debug: (event, context) => {
    console.debug(`[kasakame:${event}]`, context)
  },
  info: (event, context) => {
    console.info(`[kasakame:${event}]`, context)
  },
  warn: (event, context) => {
    console.warn(`[kasakame:${event}]`, context)
  },
  error: (event, context) => {
    console.error(`[kasakame:${event}]`, context)
  },
}

const NOOP_LOGGER: SdkLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** Development-only structured logger injected into the SDK; production keeps it silent. */
export const frontendSdkLogger: SdkLogger = import.meta.env.DEV ? createLevelLogger(configuredLevel(), DEV_LOGGER) : NOOP_LOGGER

function configuredLevel(): SdkLogLevel {
  const value = import.meta.env.VITE_LOG_LEVEL
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value
  return 'debug'
}

/**
 * Log an action failure for debugging; console output never leaves the browser, so addresses and error details are safe to include.
 *
 * @param context The action that failed (pledge, create, claim, ...).
 * @param error The caught failure.
 */
export function logError(context: string, error: unknown): void {
  frontendSdkLogger.error(context, { error })
}
