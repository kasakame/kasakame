import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { consoleLogger } from '@algorandfoundation/algokit-utils/types/logging'
import { deploy as deployVault } from './claimsvault'
import { deploy as deployRegistry } from './registry'

interface Deployer {
  name: string
  deploy: () => Promise<unknown>
}

// Uncomment `traceAll` to generate AVM Debugger source maps and traces: https://github.com/algorandfoundation/algokit-avm-vscode-Debugger

Config.configure({
  logger: consoleLogger,
  debug: true,
  //  traceAll: true,
})
registerDebugEventHandlers()

/** Platform deployers, in order: the Registry fixes the hashes/sweep target/window, then the vault records and binds. */
const DEPLOYERS: readonly Deployer[] = [
  { name: 'registry', deploy: deployRegistry },
  { name: 'claimsvault', deploy: deployVault },
]

// Execute the deployers; the first failure stops the command and sets a non-zero exit code.
void (async () => {
  const name = process.argv[2]
  const selected = name === undefined ? DEPLOYERS : DEPLOYERS.filter((deployer) => deployer.name === name)

  if (selected.length === 0) {
    throw new Error(`No deployer found for contract name: ${name ?? 'unknown'}`)
  }

  for (const deployer of selected) {
    const appId = await deployer.deploy()
    // A fresh Registry id feeds the vault deployer in the same command; no env edit needed.
    if (deployer.name === 'registry' && typeof appId === 'bigint') {
      process.env.REGISTRY_APP_ID = appId.toString()
    }
  }
})().catch((error: unknown) => {
  console.error('Deployment failed:', error)
  process.exitCode = 1
})
