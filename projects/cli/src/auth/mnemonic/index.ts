import type { WalletSession } from '@kasakame/sdk'
import { makeBasicAccountTransactionSigner, mnemonicToSecretKey } from 'algosdk'
import { readFileSync } from 'node:fs'
import { peraSession } from './pera.js'

/**
 * Read the mnemonic from a file or the environment.
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
 * Decode a 25-word Algo25 or 24-word Pera Universal Wallet mnemonic into an SDK wallet session; a 24-word phrase uses `address` to pick the signing account.
 *
 * @param file Optional mnemonic file path.
 * @param env Environment variables to read.
 * @param address Address the phrase must control; required for 24-word phrases.
 * @returns The address and local signer.
 */
export async function mnemonicSession(
  file: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  address?: string,
): Promise<WalletSession> {
  const words = resolveMnemonic(file, env)
  if (words.split(/\s+/).length === 24) {
    if (address === undefined) {
      throw new Error(
        'A 24-word Pera Universal Wallet phrase can derive several accounts; pass --address so the CLI knows which one to sign with',
      )
    }
    return peraSession(words, address)
  }

  let account
  try {
    account = mnemonicToSecretKey(words)
  } catch {
    throw new Error('Invalid mnemonic: expected a 25-word Algo25 phrase or a 24-word Pera Universal Wallet phrase')
  }

  const derived = account.addr.toString()
  if (address !== undefined && address !== derived) {
    throw new Error(`The mnemonic does not control ${address}`)
  }
  return { address: derived, signer: makeBasicAccountTransactionSigner(account) }
}
