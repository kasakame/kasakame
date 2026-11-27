import { logout } from '../auth/wallet/index.js'

/**
 * Disconnect the stored wallet session.
 *
 * @returns Process exit code.
 */
export async function runLogout(): Promise<number> {
  const disconnected = await logout()
  console.log(disconnected ? 'Disconnected.' : 'No active wallet session.')
  return 0
}
