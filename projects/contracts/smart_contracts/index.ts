import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { consoleLogger } from '@algorandfoundation/algokit-utils/types/logging'
import * as fs from 'node:fs'
import * as path from 'node:path'

interface Deployer {
  name: string
  deploy: () => Promise<unknown>
}

// Uncomment the traceAll option to enable auto generation of AVM Debugger compliant sourceMap and simulation trace file for all AVM calls.
// Learn more about using AlgoKit AVM Debugger to debug your TEAL source codes and inspect various kinds of Algorand transactions in atomic groups -> https://github.com/algorandfoundation/algokit-avm-vscode-Debugger

Config.configure({
  logger: consoleLogger,
  debug: true,
  //  traceAll: true,
})
registerDebugEventHandlers()

// base directory
const baseDir = path.resolve(__dirname)

// function to validate and dynamically import a module
async function importDeployerIfExists(dir: string): Promise<Deployer | null> {
  const deployerPath = path.resolve(dir, 'deploy-config')
  if (fs.existsSync(deployerPath + '.ts') || fs.existsSync(deployerPath + '.js')) {
    const module = (await import(deployerPath)) as { deploy: Deployer['deploy'] }
    return { deploy: module.deploy, name: path.basename(dir) }
  }
  return null
}

/**
 * Deployers that a bare `deploy:*` command runs, in order: the vault's `create` records the Factory id and binds to it.
 * Example deployers (the demo campaign) only run when named explicitly.
 */
const PLATFORM_DEPLOYERS = ['factory', 'claimsvault']

// get a list of all deployers from the subdirectories, platform deployers first
async function getDeployers(): Promise<Deployer[]> {
  const directories = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.resolve(baseDir, dirent.name))

  const deployers = await Promise.all(directories.map(importDeployerIfExists))
  return deployers
    .filter((deployer): deployer is Deployer => deployer !== null)
    .sort((left, right) => {
      const rank = (name: string) => {
        const index = PLATFORM_DEPLOYERS.indexOf(name)
        return index === -1 ? PLATFORM_DEPLOYERS.length : index
      }
      return rank(left.name) - rank(right.name)
    })
}

// execute the deployers; the first failure stops the command and sets a non-zero exit code
void (async () => {
  const contractName = process.argv.length > 2 ? process.argv[2] : undefined
  const contractDeployers = await getDeployers()

  const filteredDeployers = contractName
    ? contractDeployers.filter((deployer) => deployer.name === contractName)
    : contractDeployers.filter((deployer) => PLATFORM_DEPLOYERS.includes(deployer.name))

  if (filteredDeployers.length === 0) {
    throw new Error(
      contractName === undefined ? `No platform deployers found in ${baseDir}` : `No deployer found for contract name: ${contractName}`,
    )
  }

  for (const deployer of filteredDeployers) {
    const appId = await deployer.deploy()
    // A fresh Factory id feeds the vault deployer in the same command; no env edit needed.
    if (deployer.name === 'factory' && typeof appId === 'bigint') {
      process.env.FACTORY_APP_ID = appId.toString()
    }
  }
})().catch((error: unknown) => {
  console.error('Deployment failed:', error)
  process.exitCode = 1
})
