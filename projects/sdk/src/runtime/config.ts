import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { SdkLogger } from './log.js'
import { setSdkLogger } from './log.js'

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
 * @param logger Optional structured logger; defaults to a no-op.
 */
export function configureSdk(config: SdkConfig, logger?: SdkLogger): void {
  session = config
  setSdkLogger(logger)
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
