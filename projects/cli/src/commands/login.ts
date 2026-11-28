import type { CommandContext } from '../app/context.js'
import { login } from '../auth/wallet/index.js'

/**
 * Pair a wallet over WalletConnect, or report the stored session.
 *
 * @param _context Parsed command context; session commands do not open a signer.
 * @returns Process exit code.
 */
export async function runLogin(_context: CommandContext): Promise<number> {
  const result = await login()
  if (result.reused) {
    console.log(`Already logged in as ${result.session.address} (${result.session.walletName}).`)
  } else {
    console.log(`Connected ${result.session.walletName} as ${result.session.address}.`)
  }
  return 0
}
