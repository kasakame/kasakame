import { parseCliOptions, type CliOptions } from './args.js'
import { configureCliChain } from './chain.js'
import { runCancel, runClaim, runRefund } from './commands.js'
import { mnemonicSession } from './mnemonic.js'
import { login, logout, whoami } from './walletconnect.js'

const USAGE = `Usage: kasakame <command> [options]

Commands:
  login            Pair a wallet over WalletConnect
  whoami           Show the connected wallet or mnemonic address
  logout           Disconnect the wallet session
  refund <appId>   Backer: refund your pledges from a failed campaign
  cancel <appId>   Backer: cancel your pledges while a campaign is open
  claim <appId>    Creator: claim a successful campaign's funds

Options:
  --network <testnet|localnet|custom>  Network (default: testnet)
  --vault <appId>                      ClaimsVault app id (default: 774437570 on testnet)
  --factory <appId>                    Factory app id (default: 774437557 on testnet)
  --signer <wallet|mnemonic>           Signer (default: wallet on testnet, mnemonic otherwise)
  --mnemonic-file <path>               Algo25 mnemonic file (or KASAKAME_MNEMONIC)
  --dry-run                            Print planned transactions without signing
  --help, -h                           Show this help
`

/**
 * Run the CLI.
 *
 * @param argv Command-line arguments, excluding the node binary and script path.
 * @returns Process exit code.
 */
export async function run(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }

  try {
    const options = parseCliOptions(argv)
    switch (options.command) {
      case 'login':
        return await runLogin()
      case 'whoami':
        return await runWhoami(options)
      case 'logout':
        return await runLogout()
      case 'refund':
        configureCliChain(options)
        return await runRefund(options)
      case 'cancel':
        configureCliChain(options)
        return await runCancel(options)
      case 'claim':
        configureCliChain(options)
        return await runClaim(options)
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

async function runLogin(): Promise<number> {
  const result = await login()
  if (result.reused) {
    console.log(`Already logged in as ${result.session.address} (${result.session.walletName}).`)
  } else {
    console.log(`Connected ${result.session.walletName} as ${result.session.address}.`)
  }
  console.log(`Session expires: ${formatExpiry(result.session.expiry)}`)
  return 0
}

async function runWhoami(options: CliOptions): Promise<number> {
  if (options.signer === 'mnemonic') {
    const wallet = mnemonicSession(options.mnemonicFile)
    console.log('Signer: mnemonic')
    console.log(`Address: ${wallet.address}`)
    console.log(`Network: ${options.network}`)
    return 0
  }

  const session = await whoami()
  if (session === undefined) {
    console.error('No active wallet session. Run `kasakame login` first.')
    return 1
  }

  console.log(`Wallet: ${session.walletName}`)
  console.log(`Address: ${session.address}`)
  console.log(`Chain: ${session.chainId}`)
  console.log(`Session expires: ${formatExpiry(session.expiry)}`)
  return 0
}

async function runLogout(): Promise<number> {
  const disconnected = await logout()
  console.log(disconnected ? 'Disconnected.' : 'No active wallet session.')
  return 0
}

function formatExpiry(expiry: number): string {
  return new Date(expiry * 1000).toISOString()
}
