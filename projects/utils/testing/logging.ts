import { Config } from '@algorandfoundation/algokit-utils'
import { consoleLogger, infoConsoleLogger, nullLogger, type Logger } from '@algorandfoundation/algokit-utils/types/logging'

const LOGGERS = new Map<string, Logger>([
  ['silent', nullLogger],
  ['info', infoConsoleLogger],
  ['debug', consoleLogger],
])

/**
 * Configure AlgoKit Utils logging for a test run from `KASAKAME_TEST_LOG`; silent by default.
 *
 * @throws {Error} When `KASAKAME_TEST_LOG` is not `silent`, `info`, or `debug`.
 */
export function configureTestLogging(): void {
  const level = process.env.KASAKAME_TEST_LOG || 'silent'
  const logger = LOGGERS.get(level)
  if (logger === undefined) {
    throw new Error(`KASAKAME_TEST_LOG=${level} must be silent, info, or debug`)
  }
  Config.configure({ logger })
}
