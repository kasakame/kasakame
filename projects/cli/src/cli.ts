import { login, logout, whoami } from './walletconnect.js'

const USAGE = `Usage: kasakame <command> [options]

Commands:
  login            Pair a wallet over WalletConnect
  whoami           Show the connected wallet and session
  logout           Disconnect the wallet session

Planned:
  refund <appId>   Refund live pledges from a failed campaign
  cancel <appId>   Cancel live pledges while a campaign is open
  claim <appId>    Claim a successful campaign as the creator

Options:
  --help, -h       Show this help
`

/**
 * Run the CLI.
 *
 * @param argv Command-line arguments, excluding the node binary and script path.
 * @returns Process exit code.
 */
export async function run(argv: string[]): Promise<number> {
  const command = argv[0]
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE)
    return 0
  }

  try {
    switch (command) {
      case 'login':
        return await runLogin()
      case 'whoami':
        return await runWhoami()
      case 'logout':
        return await runLogout()
      default:
        console.error(`Not implemented yet: ${command}`)
        return 1
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

async function runWhoami(): Promise<number> {
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
