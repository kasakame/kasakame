import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { configureSdk } from '@kasakame/sdk'
import algosdk from 'algosdk'
import { appIdFromEnv, getAlgodConfigFromViteEnvironment, getIndexerConfigFromViteEnvironment } from '../utils/network/getAlgoClientConfigs'
import { frontendSdkLogger } from './log'

/**
 * Shared service singletons: one `AlgorandClient` (writes) and one indexer (reads), configured from the Vite environment; construction does no network I/O, so this is safe at module load.
 */

const algodConfig = getAlgodConfigFromViteEnvironment()
const indexerConfig = getIndexerConfigFromViteEnvironment()

function buildIndexerToken(): algosdk.IndexerTokenHeader | string {
  const token = indexerConfig.token
  // `TokenHeader` is an object form ({ 'X-Indexer-API-Token': ... }); strings pass through.
  return typeof token === 'string' ? token : (token as algosdk.IndexerTokenHeader)
}

export const indexer = new algosdk.Indexer(buildIndexerToken(), indexerConfig.server, indexerConfig.port)

export const algorand = AlgorandClient.fromConfig({
  algodConfig: {
    server: algodConfig.server,
    port: algodConfig.port,
    token: algodConfig.token,
  },
  indexerConfig: {
    server: indexerConfig.server,
    port: indexerConfig.port,
    token: indexerConfig.token,
  },
})

// Hand the session to the SDK at startup; chain plumbing (timestamp, indexer waiters) is re-exported below and replay/campaign reads use the same session.
configureSdk(
  {
    algorand,
    registryAppId: appIdFromEnv('VITE_REGISTRY_APP_ID'),
    vaultAppId: appIdFromEnv('VITE_VAULT_APP_ID'),
  },
  frontendSdkLogger,
)

export { fetchChainTimestamp, waitForIndexerCatchUp, waitForIndexerRound } from '@kasakame/sdk'
