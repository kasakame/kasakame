import type { CommandContext } from '../app/context.js'
import { mnemonicSession } from '../auth/mnemonic/index.js'
import { whoami } from '../auth/wallet/index.js'

/**
 * Show the active signer's address.
 *
 * @param context Parsed command context.
 * @returns Process exit code.
 */
export async function runWhoami(context: CommandContext): Promise<number> {
  const { options } = context
  if (options.signer === 'mnemonic') {
    const wallet = await mnemonicSession(options.mnemonicFile, undefined, options.address)
    console.log('Signer: mnemonic')
    console.log(`Address: ${wallet.address}`)
    console.log(`Network: ${options.network}`)
    return 0
  }

  const session = await whoami()
  if (session === undefined) {
    console.error('No active wallet session. Run `kasakame login` first.')
    return 1
  }

  console.log(`Wallet: ${session.walletName}`)
  console.log(`Address: ${session.address}`)
  return 0
}
