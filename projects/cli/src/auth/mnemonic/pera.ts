import { BIP32DerivationType, KeyContext, XHDWalletAPI, fromSeed } from '@algorandfoundation/xhd-wallet-api'
import type { WalletSession } from '@kasakame/sdk'
import { addressWithSignersFromRawEd25519Signer, encodeAddress, isValidAddress } from 'algosdk'
import { mnemonicToSeedSync } from 'bip39'

const PERA_ACCOUNT_LIMIT = 50

interface PeraAccount {
  xhd: XHDWalletAPI
  rootKey: Uint8Array
  publicKey: Uint8Array
  account: number
  mode: BIP32DerivationType
}

async function findPeraAccount(words: string, address: string): Promise<PeraAccount> {
  if (!isValidAddress(address)) {
    throw new Error(`Invalid address: ${address}`)
  }

  const rootKey = fromSeed(Buffer.from(mnemonicToSeedSync(words.trim().toLowerCase(), '')))
  const xhd = new XHDWalletAPI()
  for (const mode of [BIP32DerivationType.Peikert, BIP32DerivationType.Khovratovich]) {
    for (let account = 0; account < PERA_ACCOUNT_LIMIT; account++) {
      const publicKey = await xhd.keyGen(rootKey, KeyContext.Address, account, 0, mode)
      if (encodeAddress(publicKey) === address) return { xhd, rootKey, publicKey, account, mode }
    }
  }

  throw new Error(
    `No account in the 24-word mnemonic matches ${address} (checked ARC-52 Peikert/Khovratovich, accounts 0-${String(PERA_ACCOUNT_LIMIT - 1)}).`,
  )
}

/**
 * Verify a 24-word Pera Universal Wallet phrase controls an address, without building a transaction signer.
 *
 * @param words The 24-word BIP-39 phrase.
 * @param address The address the phrase must control.
 * @returns The matched address.
 */
export async function peraAddress(words: string, address: string): Promise<string> {
  await findPeraAccount(words, address)
  return address
}

/**
 * Derive the account behind a 24-word Pera Universal Wallet phrase (BIP-39 HD, ARC-52), scanning both modes until one matches `address`.
 *
 * @param words The 24-word BIP-39 phrase.
 * @param address The address the phrase must control.
 * @returns The matched address and its transaction signer.
 */
export async function peraSession(words: string, address: string): Promise<WalletSession> {
  const { xhd, rootKey, publicKey, account, mode } = await findPeraAccount(words, address)
  const { txnSigner } = addressWithSignersFromRawEd25519Signer({
    ed25519PublicKey: publicKey,
    ed25519Signer: (bytes) => xhd.signAlgoTransaction(rootKey, KeyContext.Address, account, 0, bytes, mode),
  })
  return { address, signer: txnSigner }
}
