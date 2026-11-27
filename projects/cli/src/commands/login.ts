import { login } from '../auth/wallet/index.js'

/**
 * Pair a wallet over WalletConnect, or report the stored session.
 *
 * @returns Process exit code.
 */
export async function runLogin(): Promise<number> {
  const result = await login()
  if (result.reused) {
    console.log(`Already logged in as ${result.session.address} (${result.session.walletName}).`)
  } else {
    console.log(`Connected ${result.session.walletName} as ${result.session.address}.`)
  }
  return 0
}
