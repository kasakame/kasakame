import { withTimeout } from './client.js'
import type { WalletConnectOptions } from './types.js'

const BRIDGE_CONFIG_URL = 'https://wc.perawallet.app/config.json'
const FALLBACK_BRIDGE = 'https://wallet-connect-a.perawallet.app'
const BRIDGE_TIMEOUT_MS = 10_000

/**
 * Pick a WalletConnect v1 bridge from the Pera config, with a known fallback.
 *
 * @param options Overrides for the bridge.
 * @returns The bridge URL.
 */
export async function resolveBridge(options: WalletConnectOptions): Promise<string> {
  if (options.bridge !== undefined) return options.bridge
  try {
    const response = await withTimeout(fetch(BRIDGE_CONFIG_URL), BRIDGE_TIMEOUT_MS, 'Timed out reading the WalletConnect bridge list')
    const config = (await response.json()) as { servers?: string[] }
    const servers = config.servers ?? []
    const index = Math.floor(Math.random() * servers.length)
    return servers[index] ?? FALLBACK_BRIDGE
  } catch {
    return FALLBACK_BRIDGE
  }
}
