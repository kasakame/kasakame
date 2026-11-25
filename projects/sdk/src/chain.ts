import type { AlgorandClient } from '@algorandfoundation/algokit-utils'

/** The session the SDK operates on: one configured `AlgorandClient` plus the app ids. */
export interface SdkConfig {
  /** The algod/indexer client every SDK read and write goes through. */
  algorand: AlgorandClient
  /** Registry app id (the campaign registry). */
  registryAppId: bigint
  /** ClaimsVault app id (pledge pool + refunds). */
  vaultAppId: bigint
}

let session: SdkConfig | undefined

/**
 * Configure the SDK session. Call once at startup: the frontend passes its `AlgorandClient`, the CLI builds one from flags/env.
 *
 * @param config The session configuration.
 */
export function configureSdk(config: SdkConfig): void {
  session = config
}

/**
 * The configured session.
 *
 * @returns The session configuration.
 */
export function getSdkConfig(): SdkConfig {
  if (session === undefined) throw new Error('SDK not configured: call configureSdk() first')
  return session
}

/**
 * The chain's current timestamp (latest block header), in seconds; wall-clock time is wrong on time-traveled chains and can drift from consensus.
 *
 * @returns UNIX timestamp in seconds.
 */
export async function fetchChainTimestamp(): Promise<bigint> {
  const algod = getSdkConfig().algorand.client.algod
  const status = await algod.status().do()
  const block = await algod.block(status.lastRound).headerOnly(true).do()
  return block.block.header.timestamp
}

/**
 * Poll the indexer until it has indexed at least the given round; reads right after a confirmed write can race it and return stale state.
 *
 * @param round The round the indexer must catch up to (inclusive).
 * @param timeoutMs Maximum time to wait before giving up. Defaults to 10s.
 * @param pollMs Delay between polls. Defaults to 250ms.
 * @returns A promise that resolves once the indexer has caught up, or after the timeout.
 */
export async function waitForIndexerRound(round: bigint, timeoutMs = 10_000, pollMs = 250): Promise<void> {
  const indexer = getSdkConfig().algorand.client.indexer
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const health = await indexer.makeHealthCheck().do()
      if (health.round >= round) return
    } catch {
      // Indexer temporarily unreachable - retry until the timeout elapses.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * Wait until the indexer has applied everything algod has committed up to now (for writes whose confirmation round isn't available).
 *
 * @param timeoutMs Maximum time to wait before giving up. Defaults to 10s.
 * @param pollMs Delay between polls. Defaults to 250ms.
 * @returns A promise that resolves once the indexer has caught up, or after the timeout.
 */
export async function waitForIndexerCatchUp(timeoutMs = 10_000, pollMs = 250): Promise<void> {
  const status = await getSdkConfig().algorand.client.algod.status().do()
  await waitForIndexerRound(status.lastRound, timeoutMs, pollMs)
}

/**
 * Wait for the indexer after a confirmed write; a read failure is not a write failure, so this never throws. The next read retries.
 *
 * @param timeoutMs Maximum time to wait before giving up. Defaults to 10s.
 * @param pollMs Delay between polls. Defaults to 250ms.
 */
export async function waitForIndexerCatchUpBestEffort(timeoutMs = 10_000, pollMs = 250): Promise<void> {
  try {
    await waitForIndexerCatchUp(timeoutMs, pollMs)
  } catch {
    // The write is confirmed; the next read retries.
  }
}
