import type { WalletSession } from '@kasakame/sdk'
import { type Account, makeBasicAccountTransactionSigner, mnemonicToSecretKey } from 'algosdk'
import { readFileSync } from 'node:fs'
import { peraAddress, peraSession } from './pera.js'

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

function peraTarget(address: string | undefined): string {
  if (address === undefined) {
    throw new Error(
      'A 24-word Pera Universal Wallet phrase can derive several accounts; pass --address so the CLI knows which one to sign with',
    )
  }
  return address
}

function algo25Account(words: string, address: string | undefined): Account {
  let account: Account
  try {
    account = mnemonicToSecretKey(words)
  } catch {
    throw new Error('Invalid mnemonic: expected a 25-word Algo25 phrase or a 24-word Pera Universal Wallet phrase')
  }

  const derived = account.addr.toString()
  if (address !== undefined && address !== derived) {
    throw new Error(`The mnemonic does not control ${address}`)
  }
  return account
}

/**
 * Resolve a 25-word Algo25 or 24-word Pera Universal Wallet mnemonic to its address without building a transaction signer.
 *
 * @param file Optional mnemonic file path.
 * @param env Environment variables to read.
 * @param address Address the phrase must control; required for 24-word phrases.
 * @returns The address the phrase controls.
 */
export async function mnemonicAddress(file: string | undefined, env: NodeJS.ProcessEnv = process.env, address?: string): Promise<string> {
  const words = resolveMnemonic(file, env)
  if (words.split(/\s+/).length === 24) {
    return peraAddress(words, peraTarget(address))
  }
  return algo25Account(words, address).addr.toString()
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
    return peraSession(words, peraTarget(address))
  }

  const account = algo25Account(words, address)
  return { address: account.addr.toString(), signer: makeBasicAccountTransactionSigner(account) }
}
