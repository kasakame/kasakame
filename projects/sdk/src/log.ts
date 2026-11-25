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
