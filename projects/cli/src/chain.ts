import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { configureSdk } from '@kasakame/sdk'
import type { CliOptions } from './args.js'

/**
 * Build the Algod/indexer client for the selected network and configure the SDK session.
 *
 * @param options Parsed CLI options.
 */
export function configureCliChain(options: CliOptions): void {
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
