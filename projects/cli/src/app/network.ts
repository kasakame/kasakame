import { AlgorandClient, Config } from '@algorandfoundation/algokit-utils'
import { warningConsoleLogger } from '@algorandfoundation/algokit-utils/types/logging'
import type { SdkLogger } from '@kasakame/sdk'
import { configureSdk, createLevelLogger } from '@kasakame/sdk'
import type { CliOptions } from './options.js'

const verboseLogger: SdkLogger = {
  debug: (event, context) => {
    write('debug', event, context)
  },
  info: (event, context) => {
    write('info', event, context)
  },
  warn: (event, context) => {
    write('warn', event, context)
  },
  error: (event, context) => {
    write('error', event, context)
  },
}

function write(level: string, event: string, context: Readonly<Record<string, unknown>> | undefined): void {
  console.error(`[sdk:${level}] ${event}${context === undefined ? '' : ` ${JSON.stringify(context)}`}`)
}

/**
 * Build the Algod/indexer client for the selected network and configure the SDK session.
 *
 * @param options Parsed CLI options.
 */
export function configureNetwork(options: CliOptions): void {
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

  const config = {
    algorand,
    registryAppId: options.registryAppId ?? 0n,
    vaultAppId: options.vaultAppId ?? 0n,
  }
  if (options.logLevel !== undefined) configureSdk(config, createLevelLogger(options.logLevel, verboseLogger))
  else configureSdk(config)
}
