export const USAGE = `Usage: kasakame <command> [options]

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
