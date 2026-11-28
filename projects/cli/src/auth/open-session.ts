import type { WalletSession } from '@kasakame/sdk'
import type { CliOptions } from '../app/options.js'
import { mnemonicSession } from './mnemonic/index.js'
import { openWalletConnection } from './wallet/index.js'

export interface SignerSession {
  wallet: WalletSession
  close: () => Promise<void>
}

/**
 * Open the configured signer as an SDK wallet session.
 *
 * @param options Parsed CLI options.
 * @returns The signer and a cleanup function.
 */
export async function openCliSession(options: CliOptions): Promise<SignerSession> {
  if (options.signer === 'mnemonic') {
    return {
      wallet: await mnemonicSession(options.mnemonicFile, undefined, options.address),
      close: () => Promise.resolve(),
    }
  }

  const connection = await openWalletConnection()
  return { wallet: connection.wallet, close: connection.close }
}
