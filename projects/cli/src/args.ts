import { parseArgs } from 'node:util'

export type CommandName = 'login' | 'whoami' | 'logout' | 'pledges' | 'campaigns' | 'refund' | 'withdraw' | 'claim' | 'delete'
export type NetworkName = 'testnet' | 'localnet' | 'custom'
export type SignerName = 'wallet' | 'mnemonic'

export interface CliOptions {
  command: CommandName
  appId?: bigint
  address?: string
  pledge?: number
  all?: boolean
  network: NetworkName
  signer: SignerName
  vaultAppId?: bigint
  factoryAppId?: bigint
  mnemonicFile?: string
  dryRun: boolean
}

const TESTNET_VAULT_APP_ID = 774437570n
const TESTNET_FACTORY_APP_ID = 774437557n

/**
 * Parse and validate the CLI arguments.
 *
 * @param argv Command-line arguments, excluding the node binary and script path.
 * @returns The resolved command and options.
 */
export function parseCliOptions(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      network: { type: 'string' },
      vault: { type: 'string' },
      factory: { type: 'string' },
      signer: { type: 'string' },
      'mnemonic-file': { type: 'string' },
      address: { type: 'string' },
      pledge: { type: 'string' },
      all: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  })

  const command = positionals[0]
  if (!isCommand(command)) {
    throw new Error(`Unknown command: ${command ?? ''}`)
  }

  const network = parseNetwork(values.network)
  if ((command === 'login' || command === 'logout') && network !== 'testnet') {
    throw new Error(`${command} is only available on testnet`)
  }

  const signer = parseSigner(values.signer, command, network)
  const transaction = isTransactionCommand(command)
  const read = isReadCommand(command)
  const needsChain = transaction || read
  const selection = command === 'refund' || command === 'withdraw'

  if (values.pledge !== undefined && !selection) {
    throw new Error('--pledge is only valid with refund or withdraw')
  }
  if (values.all === true && !selection) {
    throw new Error('--all is only valid with refund or withdraw')
  }
  if (values.pledge !== undefined && values.all === true) {
    throw new Error('--pledge and --all cannot be combined')
  }

  if (values.address !== undefined && !read) {
    throw new Error('--address is only valid with pledges or campaigns')
  }

  const mnemonicFile = values['mnemonic-file']
  if (mnemonicFile !== undefined && signer !== 'mnemonic') {
    throw new Error('--mnemonic-file requires --signer mnemonic')
  }

  const dryRun = values['dry-run'] ?? false
  if (dryRun && !transaction) {
    throw new Error('--dry-run is only valid with refund, withdraw, claim, or delete')
  }

  let appId: bigint | undefined
  if (transaction) {
    const rawAppId = positionals[1]
    if (rawAppId === undefined || positionals.length !== 2) {
      throw new Error(`${command} requires exactly one app id`)
    }
    appId = parsePositiveAppId(rawAppId, 'App id')
  } else if (positionals.length !== 1) {
    throw new Error(`${command} does not take an app id`)
  }

  const vaultAppId =
    values.vault === undefined
      ? needsChain && network === 'testnet'
        ? TESTNET_VAULT_APP_ID
        : undefined
      : parsePositiveAppId(values.vault, '--vault')
  if (needsChain && vaultAppId === undefined) {
    throw new Error(`--vault is required on ${network}`)
  }

  const factoryAppId =
    values.factory === undefined
      ? needsChain && network === 'testnet'
        ? TESTNET_FACTORY_APP_ID
        : undefined
      : parseFactoryAppId(values.factory)

  const options: CliOptions = { command, network, signer, dryRun }
  if (appId !== undefined) options.appId = appId
  if (vaultAppId !== undefined) options.vaultAppId = vaultAppId
  if (factoryAppId !== undefined) options.factoryAppId = factoryAppId
  if (mnemonicFile !== undefined) options.mnemonicFile = mnemonicFile
  if (values.address !== undefined) options.address = values.address
  if (values.pledge !== undefined) options.pledge = parsePledge(values.pledge)
  if (values.all === true) options.all = true
  return options
}

function isCommand(value: string | undefined): value is CommandName {
  return (
    value === 'login' ||
    value === 'whoami' ||
    value === 'logout' ||
    value === 'pledges' ||
    value === 'campaigns' ||
    value === 'refund' ||
    value === 'withdraw' ||
    value === 'claim' ||
    value === 'delete'
  )
}

function isTransactionCommand(command: CommandName): command is 'refund' | 'withdraw' | 'claim' | 'delete' {
  return command === 'refund' || command === 'withdraw' || command === 'claim' || command === 'delete'
}

function isReadCommand(command: CommandName): command is 'pledges' | 'campaigns' {
  return command === 'pledges' || command === 'campaigns'
}

function parseNetwork(value: string | undefined): NetworkName {
  const network = value ?? 'testnet'
  if (network === 'testnet' || network === 'localnet' || network === 'custom') {
    return network
  }
  if (network === 'mainnet') {
    throw new Error('MainNet is not supported yet')
  }
  throw new Error(`Unknown network: ${network}`)
}

function parseSigner(value: string | undefined, command: CommandName, network: NetworkName): SignerName {
  const signer = value ?? (network === 'testnet' ? 'wallet' : 'mnemonic')
  if (signer !== 'wallet' && signer !== 'mnemonic') {
    throw new Error(`Unknown signer: ${signer}`)
  }
  if ((command === 'login' || command === 'logout') && signer !== 'wallet') {
    throw new Error(`${command} only supports --signer wallet`)
  }
  if (signer === 'wallet' && network !== 'testnet') {
    throw new Error(`WalletConnect wallets do not support ${network}; use --signer mnemonic`)
  }
  return signer
}

function parsePositiveAppId(value: string, name: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`)
  }
  const appId = BigInt(value)
  if (appId <= 0n) {
    throw new Error(`${name} must be a positive integer`)
  }
  return appId
}

function parseFactoryAppId(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error('--factory must be a non-negative integer')
  }
  return BigInt(value)
}

function parsePledge(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error('--pledge must be a non-negative integer')
  }
  const pledge = Number(value)
  if (!Number.isSafeInteger(pledge)) {
    throw new Error('--pledge must be a non-negative integer')
  }
  return pledge
}
