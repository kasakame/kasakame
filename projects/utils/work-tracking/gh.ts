import { execFileSync } from 'node:child_process'
import process from 'node:process'

interface GraphQlEnvelope {
  data?: unknown
  errors?: Array<{ message: string }>
}

/**
 * Print an error and exit.
 *
 * @param message - Error text.
 */
export function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

/**
 * Return a readable message from a gh error.
 *
 * @param error - The caught error.
 * @returns The stderr or error message.
 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr
    if (typeof stderr === 'string') return stderr.trim()
    if (Buffer.isBuffer(stderr)) return stderr.toString().trim()
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run the GitHub CLI and return trimmed output.
 *
 * @param args - gh arguments.
 * @param token - Optional token that overrides gh auth.
 * @returns The trimmed stdout.
 */
export function runGh(args: string[], token?: string): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      env: token ? { ...process.env, GH_TOKEN: token } : process.env,
    }).trim()
  } catch (error) {
    throw new Error(errorMessage(error))
  }
}

/**
 * Run a GraphQL query with the GitHub CLI.
 *
 * @param query - GraphQL document.
 * @param token - Optional token that overrides gh auth.
 * @returns The GraphQL data object.
 */
export function graphql(query: string, token?: string): unknown {
  const output = runGh(['api', 'graphql', '-f', `query=${query}`], token)
  const envelope = JSON.parse(output) as GraphQlEnvelope
  if (envelope.errors?.length) throw new Error(envelope.errors.map((error) => error.message).join('; '))
  if (!envelope.data) throw new Error('GitHub returned no data')
  return envelope.data
}
