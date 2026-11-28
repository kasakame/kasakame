import { openCliSession, type SignerSession } from '../auth/open-session.js'
import type { CliOptions } from './options.js'

/** Per-invocation command state: parsed options plus a signer opened on first use. */
export interface CommandContext {
  readonly options: CliOptions
  session(): Promise<SignerSession>
}

/** A command entry point. */
export type Command = (context: CommandContext) => Promise<number>

/** A command context whose memoized signer the dispatcher closes after the command. */
export interface OpenCommandContext extends CommandContext {
  close(): Promise<void>
}

/**
 * Build a context that opens the configured signer once, on the first `session()` call.
 *
 * @param options Parsed CLI options.
 * @returns The lazy context.
 */
export function createCommandContext(options: CliOptions): OpenCommandContext {
  let pending: Promise<SignerSession> | undefined
  return {
    options,
    session() {
      pending ??= openCliSession(options)
      return pending
    },
    async close() {
      if (pending === undefined) return
      try {
        const session = await pending
        await session.close()
      } catch {
        // The command result already decides the exit code; a failed open or close must not change it.
      }
    },
  }
}
