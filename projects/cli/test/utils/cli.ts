import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/index.js')

/** Options for one spawned CLI run. */
export interface CliRunOptions {
  /** Phrase exported as `KASAKAME_MNEMONIC`; omitted means an empty phrase. */
  mnemonic?: string
  /** Adds `--network` unless the argv already carries it. Defaults to localnet. */
  network?: 'localnet' | 'testnet' | 'custom'
  /** Adds `--vault` when set. */
  vaultAppId?: bigint
  /** Adds `--registry` when set. */
  registryAppId?: bigint
  /** Extra environment entries; `KASAKAME_MNEMONIC` is controlled by `mnemonic`. */
  env?: NodeJS.ProcessEnv
}

/** The captured process result. */
export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

function withSharedFlags(argv: string[], options: CliRunOptions): string[] {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return [...argv]
  const args = [...argv]
  const network = options.network ?? 'localnet'
  if (!args.includes('--network')) args.push('--network', network)
  if (network !== 'testnet' && !args.includes('--signer')) args.push('--signer', 'mnemonic')
  if (options.vaultAppId !== undefined && !args.includes('--vault')) args.push('--vault', options.vaultAppId.toString())
  if (options.registryAppId !== undefined && !args.includes('--registry')) args.push('--registry', options.registryAppId.toString())
  return args
}

/**
 * Run the built CLI with the mnemonic signer and capture its exit code and streams.
 *
 * @param argv Command and flags, without the shared network/signer/deployment flags.
 * @param options Signer, deployment ids, and environment.
 * @returns The process result.
 */
export async function runCli(argv: string[], options: CliRunOptions = {}): Promise<CliResult> {
  const args = withSharedFlags(argv, options)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KASAKAME_MNEMONIC: options.mnemonic ?? '',
    ...options.env,
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: path.dirname(entry),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 90_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (signal !== null) {
        reject(new Error(`CLI terminated by ${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      resolve({ code, stdout, stderr })
    })
  })
}

/**
 * Assert the CLI exited successfully.
 *
 * @param result The captured process result.
 */
export function expectCliOk(result: CliResult): void {
  expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
}

/**
 * Assert the CLI exited non-zero with the expected message on stderr.
 *
 * @param result The captured process result.
 * @param message Stable substring or pattern the user-facing message must match.
 */
export function expectCliError(result: CliResult, message: string | RegExp): void {
  expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1)
  if (typeof message === 'string') expect(result.stderr).toContain(message)
  else expect(result.stderr).toMatch(message)
}
