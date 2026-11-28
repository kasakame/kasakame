import type { CommandContext } from '../app/context.js'
import { logout } from '../auth/wallet/index.js'

/**
 * Disconnect the stored wallet session.
 *
 * @param _context Parsed command context; session commands do not open a signer.
 * @returns Process exit code.
 */
export async function runLogout(_context: CommandContext): Promise<number> {
  const disconnected = await logout()
  console.log(disconnected ? 'Disconnected.' : 'No active wallet session.')
  return 0
}
