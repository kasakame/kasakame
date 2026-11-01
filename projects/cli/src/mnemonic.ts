import { BIP32DerivationType, KeyContext, XHDWalletAPI, fromSeed } from '@algorandfoundation/xhd-wallet-api'
import type { WalletSession } from '@kasakame/sdk'
import {
  addressWithSignersFromRawEd25519Signer,
  encodeAddress,
  isValidAddress,
  makeBasicAccountTransactionSigner,
  mnemonicToSecretKey,
} from 'algosdk'
import { mnemonicToSeedSync } from 'bip39'
import { readFileSync } from 'node:fs'

const PERA_ACCOUNT_LIMIT = 50

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
 * Decode a 25-word Algo25 or 24-word Pera Universal Wallet mnemonic into an SDK wallet session.
 *
 * A 24-word BIP-39 phrase can derive several accounts through ARC-52, so `address` picks the one that signs.
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
    return peraUniversalWalletSession(words, address)
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

/**
 * Derive the account behind a 24-word Pera Universal Wallet phrase (BIP-39 HD, ARC-52).
 *
 * Scans both ARC-52 derivation modes and the first accounts until one matches `address`.
 *
 * @param words The 24-word BIP-39 phrase.
 * @param address The address the phrase must control.
 * @returns The matched address and its transaction signer.
 */
async function peraUniversalWalletSession(words: string, address: string): Promise<WalletSession> {
  if (!isValidAddress(address)) {
    throw new Error(`Invalid address: ${address}`)
  }

  const rootKey = fromSeed(Buffer.from(mnemonicToSeedSync(words.trim().toLowerCase(), '')))
  const xhd = new XHDWalletAPI()
  for (const mode of [BIP32DerivationType.Peikert, BIP32DerivationType.Khovratovich]) {
    for (let account = 0; account < PERA_ACCOUNT_LIMIT; account++) {
      const publicKey = await xhd.keyGen(rootKey, KeyContext.Address, account, 0, mode)
      if (encodeAddress(publicKey) !== address) continue
      const { txnSigner } = addressWithSignersFromRawEd25519Signer({
        ed25519PublicKey: publicKey,
        ed25519Signer: (bytes) => xhd.signAlgoTransaction(rootKey, KeyContext.Address, account, 0, bytes, mode),
      })
      return { address, signer: txnSigner }
    }
  }

  throw new Error(
    `No account in the 24-word mnemonic matches ${address} (checked ARC-52 Peikert/Khovratovich, accounts 0-${String(PERA_ACCOUNT_LIMIT - 1)}).`,
  )
}
