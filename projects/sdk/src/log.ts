/** Structured SDK logger; every method takes a stable event name and JSON-friendly context. */
export interface SdkLogger {
  /** Detailed diagnostics for routing and recovery decisions. */
  debug(event: string, context?: Readonly<Record<string, unknown>>): void
  /** Notable successful steps. */
  info(event: string, context?: Readonly<Record<string, unknown>>): void
  /** Recoverable failures, such as an indexer wait timeout. */
  warn(event: string, context?: Readonly<Record<string, unknown>>): void
  /** Failures the caller will also see. */
  error(event: string, context?: Readonly<Record<string, unknown>>): void
}

/** Minimum severity a logger prints; `debug` is the most verbose. */
export type SdkLogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Readonly<Record<SdkLogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const NOOP_LOGGER: SdkLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

let activeLogger: SdkLogger | undefined

/**
 * Install the structured logger; omitted resets to the no-op logger.
 *
 * @param logger The logger from `configureSdk`, if any.
 */
export function setSdkLogger(logger?: SdkLogger): void {
  activeLogger = logger
}

/**
 * The active structured logger, or the no-op logger by default.
 *
 * @returns The logger for an SDK event.
 */
export function sdkLogger(): SdkLogger {
  return activeLogger ?? NOOP_LOGGER
}

/**
 * Wrap a logger so events below `minLevel` are dropped.
 *
 * @param minLevel The least severe level to print.
 * @param sink The logger that formats and writes the events.
 * @returns A filtered logger for `configureSdk`.
 */
export function createLevelLogger(minLevel: SdkLogLevel, sink: SdkLogger): SdkLogger {
  const enabled = (level: SdkLogLevel): boolean => LEVEL_RANK[level] >= LEVEL_RANK[minLevel]
  return {
    debug: (event, context) => {
      if (enabled('debug')) sink.debug(event, context)
    },
    info: (event, context) => {
      if (enabled('info')) sink.info(event, context)
    },
    warn: (event, context) => {
      if (enabled('warn')) sink.warn(event, context)
    },
    error: (event, context) => {
      sink.error(event, context)
    },
  }
}
