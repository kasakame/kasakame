/**
 * Frontend wallet helper: the write path (call assembly, retry, vault helpers, `WalletSession`) lives in `@kasakame/sdk`, re-exported here for existing importers.
 */

export * from '@kasakame/sdk'

/**
 * Best-effort disconnect to clear a dead wallet session so reconnecting is one click; never throws, so callers must fire-and-forget (`void disconnectQuietly(...)`) - a hanging disconnect would stall the UI.
 *
 * @param activeWallet The active wallet from useWallet, if any.
 */
export async function disconnectQuietly(activeWallet: { disconnect: () => Promise<void> } | null | undefined): Promise<void> {
  await activeWallet?.disconnect().catch(() => undefined)
}
