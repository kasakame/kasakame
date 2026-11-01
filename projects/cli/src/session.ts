import type { WalletSession } from '@kasakame/sdk'
import type { CliOptions } from './args.js'
import { mnemonicSession } from './mnemonic.js'
import { openWalletConnection } from './walletconnect.js'

export interface CliSession {
  wallet: WalletSession
  close: () => Promise<void>
}

/**
 * Open the configured signer as an SDK wallet session.
 *
 * @param options Parsed CLI options.
 * @returns The signer and a cleanup function.
 */
export async function openCliSession(options: CliOptions): Promise<CliSession> {
  if (options.signer === 'mnemonic') {
    return {
      wallet: mnemonicSession(options.mnemonicFile),
      close: () => Promise.resolve(),
    }
  }

  const connection = await openWalletConnection()
  return { wallet: connection.wallet, close: connection.close }
}
