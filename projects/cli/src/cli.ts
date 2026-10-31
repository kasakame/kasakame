const USAGE = `Usage: kasakame <command> [options]

Commands (planned):
  refund <appId>   Refund live pledges from a failed campaign
  cancel <appId>   Cancel live pledges while a campaign is open
  claim <appId>    Claim a successful campaign as the creator
  login            Pair a wallet over WalletConnect
  whoami           Show the connected wallet and session
  logout           Disconnect the wallet session

Options:
  --help, -h       Show this help

Status: scaffolding - commands land next.
`

/**
 * Run the CLI.
 *
 * @param argv Command-line arguments, excluding the node binary and script path.
 * @returns Process exit code.
 */
export function run(argv: string[]): number {
  const command = argv[0]
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE)
    return 0
  }

  console.error(`Not implemented yet: ${command}`)
  return 1
}
