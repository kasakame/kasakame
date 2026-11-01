import { AlgorandClient, Config } from '@algorandfoundation/algokit-utils'
import { warningConsoleLogger } from '@algorandfoundation/algokit-utils/types/logging'
import { configureSdk } from '@kasakame/sdk'
import type { CliOptions } from './args.js'

/**
 * Build the Algod/indexer client for the selected network and configure the SDK session.
 *
 * @param options Parsed CLI options.
 */
export function configureCliChain(options: CliOptions): void {
  // The SDK and generated clients log transaction IDs and app calls at debug level.
  Config.configure({ logger: warningConsoleLogger })

  if (options.network === 'custom' && (!process.env.ALGOD_SERVER || !process.env.INDEXER_SERVER)) {
    throw new Error('Custom network requires ALGOD_SERVER and INDEXER_SERVER')
  }

  const algorand =
    options.network === 'testnet'
      ? AlgorandClient.testNet()
      : options.network === 'localnet'
        ? AlgorandClient.defaultLocalNet()
        : AlgorandClient.fromEnvironment()

  configureSdk({
    algorand,
    factoryAppId: options.factoryAppId ?? 0n,
    vaultAppId: options.vaultAppId ?? 0n,
  })
}
