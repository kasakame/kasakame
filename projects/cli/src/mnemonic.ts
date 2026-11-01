import type { WalletSession } from '@kasakame/sdk'
import { makeBasicAccountTransactionSigner, mnemonicToSecretKey } from 'algosdk'
import { readFileSync } from 'node:fs'

/**
 * Read the Algo25 mnemonic from a file or the environment.
 *
 * @param file Optional mnemonic file path.
 * @param env Environment variables to read.
 * @returns The trimmed mnemonic.
 */
export function resolveMnemonic(file: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  let words: string | undefined
  if (file !== undefined) {
    try {
      words = readFileSync(file, 'utf8').trim()
    } catch {
      throw new Error(`Cannot read mnemonic file: ${file}`)
    }
  }

  words = words || env.KASAKAME_MNEMONIC?.trim()
  if (!words) {
    throw new Error('Missing mnemonic: pass --mnemonic-file or set KASAKAME_MNEMONIC')
  }
  return words
}

/**
 * Decode an Algo25 mnemonic into an SDK wallet session.
 *
 * @param file Optional mnemonic file path.
 * @param env Environment variables to read.
 * @returns The address and local signer.
 */
export function mnemonicSession(file: string | undefined, env: NodeJS.ProcessEnv = process.env): WalletSession {
  const words = resolveMnemonic(file, env)
  let account
  try {
    account = mnemonicToSecretKey(words)
  } catch {
    throw new Error('Invalid mnemonic: expected a 25-word Algo25 phrase')
  }

  return {
    address: account.addr.toString(),
    signer: makeBasicAccountTransactionSigner(account),
  }
}
