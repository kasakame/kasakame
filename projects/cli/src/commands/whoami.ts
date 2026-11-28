import type { CommandContext } from '../app/context.js'
import { resolveAddress } from './shared/lookup.js'

/**
 * Show the active signer's address.
 *
 * @param context Parsed command context.
 * @returns Process exit code.
 */
export async function runWhoami(context: CommandContext): Promise<number> {
  const { options } = context
  const resolved = await resolveAddress(options, false)
  if (resolved === undefined) {
    console.error('No active wallet session. Run `kasakame login` first.')
    return 1
  }

  if (options.signer === 'mnemonic') {
    console.log('Signer: mnemonic')
    console.log(`Address: ${resolved.address}`)
    console.log(`Network: ${options.network}`)
    return 0
  }

  console.log(`Wallet: ${resolved.walletName}`)
  console.log(`Address: ${resolved.address}`)
  return 0
}
