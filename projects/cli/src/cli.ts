import { parseCliOptions, type CliOptions } from './args.js'
import { configureCliChain } from './chain.js'
import {
  runCampaigns,
  runClaim,
  runDelete,
  runFinalize,
  runPledges,
  runRefund,
  runReleaseClaimed,
  runSettleOpen,
  runWithdraw,
} from './commands/index.js'
import { cliErrorMessage } from './errors.js'
import { mnemonicSession } from './mnemonic.js'
import { login, logout, whoami } from './walletconnect.js'

const USAGE = `Usage: kasakame <command> [options]

Commands:
  login            Pair a wallet over WalletConnect
  whoami           Show the connected wallet or mnemonic address
  logout           Disconnect the wallet session
  pledges          List your live pledges and the action to take
  campaigns        List campaigns you created and the action to take
  refund <appId>   Backer: refund your pledges from a failed campaign
  withdraw <appId> Backer: withdraw your pledges while a campaign is open
  claim <appId>    Creator: claim a successful campaign's funds
  delete <appId>   Creator: delete your campaign and reclaim its deposit

Vault cleanup (permissionless):
  settle-open <appId>      Settle a failed campaign whose creator is gone
  finalize <appId>         Sweep a failed campaign's residual and release its box
  release-claimed <appId>  Release a claimed campaign's vault box

Options:
  --network <testnet|localnet|custom>  Network (default: testnet)
  --vault <appId>                      ClaimsVault app id (default: 774437570 on testnet)
  --registry <appId>                    Registry app id (default: 774437557 on testnet)
  --signer <wallet|mnemonic>           Signer (default: wallet on testnet, mnemonic otherwise)
  --mnemonic-file <path>               Algo25 (25-word) or Pera Universal Wallet (24-word) phrase file (or KASAKAME_MNEMONIC)
  --address <address>                  Inspect this address, or the account a 24-word mnemonic signs for
  --pledge <position>                  Withdraw or refund one pledge (0-based)
  --all                                Withdraw or refund every live pledge
  --dry-run                            Print planned transactions without signing
  --log-level <debug|info|warn|error>  Print SDK diagnostics at this level and above to stderr
  --verbose                            Shorthand for --log-level debug
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

  let options: CliOptions | undefined
  try {
    options = parseCliOptions(argv)
    switch (options.command) {
      case 'login':
        return await runLogin()
      case 'whoami':
        return await runWhoami(options)
      case 'logout':
        return await runLogout()
      case 'pledges':
        configureCliChain(options)
        return await runPledges(options)
      case 'campaigns':
        configureCliChain(options)
        return await runCampaigns(options)
      case 'refund':
        configureCliChain(options)
        return await runRefund(options)
      case 'withdraw':
        configureCliChain(options)
        return await runWithdraw(options)
      case 'claim':
        configureCliChain(options)
        return await runClaim(options)
      case 'delete':
        configureCliChain(options)
        return await runDelete(options)
      case 'settle-open':
        configureCliChain(options)
        return await runSettleOpen(options)
      case 'finalize':
        configureCliChain(options)
        return await runFinalize(options)
      case 'release-claimed':
        configureCliChain(options)
        return await runReleaseClaimed(options)
    }
  } catch (error) {
    const message = cliErrorMessage(error, options?.command, options?.appId)
    console.error(`Error: ${message}`)
    if (options?.logLevel === 'debug' && error instanceof Error && message !== error.message) {
      console.error(`[detail] ${error.message}`)
    }
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
  return 0
}

async function runWhoami(options: CliOptions): Promise<number> {
  if (options.signer === 'mnemonic') {
    const wallet = await mnemonicSession(options.mnemonicFile, undefined, options.address)
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
  return 0
}

async function runLogout(): Promise<number> {
  const disconnected = await logout()
  console.log(disconnected ? 'Disconnected.' : 'No active wallet session.')
  return 0
}
