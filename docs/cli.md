# CLI

The kasakame CLI is the escape hatch for pledges and campaigns. It refunds,
withdraws, claims, and deletes by app ID from a terminal, using a wallet app or
a local mnemonic. It reads public algod and indexer endpoints and talks to no
kasakame backend, so an exit never depends on our servers.

Status: the package ships through the `release-cli` workflow; the first npm
publish is pending. From a checkout, build it with the commands in
[Development](#development).

## Install

The package is `@kasakame/cli`; the binary is `kasakame`. It requires Node.js 24
or newer.

```bash
npm install --global @kasakame/cli
kasakame --help
```

Run a one-off with `npx @kasakame/cli --help`. The package ships the compiled
`dist/`, the README, and the MIT license.

## Commands

The commands split into reads, writes, and wallet session management. Each one
prints its result and exits non-zero on failure.

| Command | What it does |
| --- | --- |
| `pledges` | List your live pledges and the action to take |
| `campaigns` | List campaigns you created and the action to take |
| `refund <appId>` | Refund your pledges from a failed campaign |
| `withdraw <appId>` | Take back your pledges while a campaign is open |
| `claim <appId>` | Claim a successful campaign as its creator |
| `delete <appId>` | Delete a campaign and reclaim its deposit |
| `login` | Pair a wallet over WalletConnect |
| `whoami` | Show the signer address |
| `logout` | Disconnect the stored wallet session |

### Find your pledges and campaigns

`pledges` lists every campaign where the signer holds a live pledge, with the
campaign status, deadline, and each pledge. `campaigns` lists the campaigns the
signer created. Without `--address`, the tables add the action the signer can
run: `withdraw` while a campaign is open, `refund` once it fails, `claim` or
`delete` for creators.

```bash
kasakame pledges
kasakame campaigns
kasakame pledges --address <address>
```

Both commands are read-only. They print a search line while they scan the
indexer, then a table, and never open a signing prompt. With `--address` they
show state only; the action columns are left out because every write needs the
pledge owner's or the creator's wallet.

Discovery combines the campaigns registered in the configured Factory with the
campaigns that have a box in the configured ClaimsVault. On TestNet the CLI
knows both app IDs. On LocalNet and custom networks, pass `--vault` and
`--factory` so discovery finds the deployment.

### Refund

Refund is the backer exit for a campaign that missed its goal.

```bash
kasakame refund <appId>
kasakame refund <appId> --dry-run
```

`refund` returns your live pledges from a failed campaign, after its deadline or
after the creator deleted it. It rejects open and successful campaigns before
the wallet is touched. The Merkle proof is built from your address, so only the
wallet that made a pledge can refund it.

With more than one live pledge, pass `--pledge <position>` to refund one or
`--all` to refund every one; a single pledge needs no flag. The wallet asks for
approval on each pledge. A failed refund is reported while the remaining
pledges still run, and the command exits non-zero if any refund failed.

`--dry-run` lists the pledges it would refund without submitting anything. It
still opens the signer to read its address.

### Withdraw

Withdraw is the backer exit while a campaign is still open.

```bash
kasakame withdraw <appId>
kasakame withdraw <appId> --dry-run
```

`withdraw` takes back your live pledges while a campaign is open, before its
deadline. It rejects campaigns that already failed or succeeded; use `refund`
after a failure. Selection and partial-failure reporting match `refund`.

### Claim

Claim is the creator exit for a successful campaign.

```bash
kasakame claim <appId>
kasakame claim <appId> --dry-run
```

`claim` pays a successful campaign's live total to its creator, after the
deadline. Only the creator can claim, and only once. Open, failed, and
already-claimed campaigns are rejected before the wallet is touched. The
ClaimsVault pays the live total: pledges minus withdrawals and refunds.

### Delete

Delete is the creator cleanup for a settled campaign.

```bash
kasakame delete <appId>
kasakame delete <appId> --dry-run
```

`delete` removes a campaign and returns its schema minimum balance and any
Factory registration deposit to the creator. It rejects open campaigns that
still hold live pledges, and funded campaigns that are not claimed yet; claim
the funds before deleting.

Deleting a failed campaign is safe. Backers keep refunding from the ClaimsVault
after the campaign app is gone, until the 730-day refund window closes. When
the campaign is registered in a Factory, the same approval sends the atomic
`[unregister, delete]` group (the Factory requires the delete immediately after
unregister; the campaign requires the unregister immediately before). An
unregistered campaign's unregister is a no-op, so the same command cleans it up.

## Options

Every command accepts the network, signer, and help flags; the rest apply to
specific commands.

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--network <testnet\|localnet\|custom>` | all | Network, default `testnet` |
| `--signer <wallet\|mnemonic>` | all | Signer, default `wallet` on TestNet and `mnemonic` otherwise |
| `--vault <appId>` | reads, writes | ClaimsVault app ID; required off TestNet |
| `--factory <appId>` | reads, writes | Factory app ID; optional off TestNet |
| `--mnemonic-file <path>` | mnemonic signer | Phrase file; otherwise `KASAKAME_MNEMONIC` |
| `--address <address>` | reads, mnemonic signer | Inspect this address, or pick the account a 24-word phrase signs for |
| `--pledge <position>` | refund, withdraw | Act on one live pledge (0-based) |
| `--all` | refund, withdraw | Act on every live pledge |
| `--dry-run` | refund, withdraw, claim, delete | Print the plan without submitting |
| `--help`, `-h` | all | Print usage |

`--pledge` and `--all` cannot be combined. `--dry-run` is rejected on reads and
on `login`, `logout`, and `whoami`. The CLI rejects unknown commands, flags, and
app IDs before it connects to anything.

## Networks

TestNet is the default. The CLI embeds the deployment this repo publishes:
Factory `774437557` and ClaimsVault `774437570`.

| Network | algod and indexer | Deployment IDs |
| --- | --- | --- |
| `testnet` | AlgoKit TestNet defaults (AlgoNode) | Built in; override with `--factory` and `--vault` |
| `localnet` | AlgoKit LocalNet defaults (`http://localhost:4001`, indexer 8980) | `--vault` required, `--factory` optional |
| `custom` | `ALGOD_*` and `INDEXER_*` environment variables | `--vault` required, `--factory` optional |

MainNet is not supported yet; the CLI rejects `--network mainnet`.

Wallet login and logout work on TestNet only. On LocalNet and custom networks,
use `--signer mnemonic`: Pera and Defly cannot target those chains.

## Signers

The CLI supports a connected wallet and a local mnemonic. Both produce the same
signer interface, so every read and transaction command works with either.

### Wallet (default on TestNet)

`kasakame login` pairs a wallet over WalletConnect and stores the session at
`~/.kasakame/walletconnect/testnet.json`. The directory is created with mode
`0700` and the session file with mode `0600`. Commands reuse the stored session;
the wallet prompts for every transaction group.

```bash
kasakame login      # print a QR and wait for the wallet
kasakame whoami     # wallet name and address
kasakame logout     # kill the stored session
```

Scan the QR with Pera or Defly. While pairing, the CLI waits five minutes for
the wallet, then exits with an error. `login` reuses an existing session and
prints it instead of pairing again.

The wallet transport is WalletConnect v1 through `@perawallet/walletconnect`,
the client Pera builds on. Pera and Defly reject v2 pairing URIs today, so the
CLI signs over v1. The bridge list comes from Pera's published config
(`https://wc.perawallet.app/config.json`), with a known Pera bridge as fallback
when that request times out. No WalletConnect Cloud project or account is
needed. The bridge is a third-party relay: if pairing fails, retry or use
the mnemonic signer. [`roadmap.md`](roadmap.md#wallet-transport) tracks the move
to WalletConnect v2 once both wallets support it.

### Mnemonic (explicit opt-in, required off TestNet)

Use the mnemonic signer when you cannot pair a wallet or want a headless run.

```bash
kasakame refund <appId> --signer mnemonic --mnemonic-file ./phrase.txt
KASAKAME_MNEMONIC="..." kasakame whoami --network testnet --signer mnemonic
```

The phrase comes from `--mnemonic-file` or `KASAKAME_MNEMONIC`, never from the
command line. The CLI accepts two formats:

- **25-word Algo25 phrase.** It signs for its own address. Pass `--address` to
  check that the phrase controls the address you expect.
- **24-word Pera Universal Wallet phrase.** It derives accounts through ARC-52:
  BIP-39 seed, then both the Peikert and Khovratovich derivation modes, accounts
  0-49. `--address` is required so the CLI knows which account signs.

A phrase on disk or in the environment is a hot key. Anyone who reads the file
or the environment controls the account, and the CLI cannot protect either.
Prefer the wallet signer. When you need the mnemonic path, use a dedicated
account, keep the phrase file at mode `0600`, and avoid exporting it in shell
history. The CLI reads the phrase but does not manage its storage.

## Self-hosting

The CLI needs no kasakame server, catalog, or IPFS gateway. It needs an algod
node and an indexer that covers the deployment's full history, because refunds
and withdrawals rebuild each pledge leaf from pledge events, including for
deleted campaigns.

To point the CLI at your own node, export the endpoints and use `--network
custom`:

```bash
export ALGOD_SERVER=https://algod.example.com
export ALGOD_TOKEN=<token>
export INDEXER_SERVER=https://indexer.example.com
export INDEXER_TOKEN=<token>

kasakame pledges --network custom --vault <vaultAppId> --factory <factoryAppId>
```

`ALGOD_PORT` and `INDEXER_PORT` are optional; so are the tokens. `--network
custom` requires `ALGOD_SERVER` and `INDEXER_SERVER`.

Pass the Factory and ClaimsVault app IDs of the deployment your campaigns use
(see [Deployments](architecture.md#deployments)). Without `--factory`, discovery
lists only campaigns that already have a ClaimsVault box, and `delete` skips
Factory unregistration. On LocalNet and custom networks, the CLI refuses every
chain command without `--vault`.

For a local run, start AlgoKit LocalNet, deploy the contracts, and copy the
printed IDs:

```bash
algokit localnet start
cd projects/contracts
npm run build
npm run deploy:localnet -- factory
npm run deploy:localnet -- claimsvault

cd ../cli
npm run build
node dist/index.js pledges --network localnet --signer mnemonic \
  --mnemonic-file ./phrase.txt --vault <vaultAppId> --factory <factoryAppId>
```

## Limitations

The CLI keeps a small scope; these are the known limits.

- One app ID per run. There is no batch or multi-campaign mode.
- WalletConnect v1 needs a reachable bridge and one approval per pledge.
- MainNet stays out until the contracts are deployed there.
- A 24-word phrase only finds accounts 0-49 in the two ARC-52 modes.
- The CLI shows campaign titles from chain state. It does not fetch IPFS
  metadata or images.

## Development

Build and test the CLI from `projects/cli`.

```bash
npm install
npm run build
node dist/index.js --help

npm run lint
npm run format
npm run check-types
npm run test:coverage
```

The Vitest suite mocks the SDK and the WalletConnect transport, covers every
command branch, and enforces 100% coverage on `src`. CI never contacts the
bridge; see [`ci.md`](ci.md#workflow-build-and-test). The release workflow packs
the tarball, installs it in a clean consumer, and runs `kasakame --help` before
publishing; see [`ci.md`](ci.md#workflow-release-cli-separate-file).

`libsodium-wrappers-sumo` is pinned to `0.7.15` directly: `0.7.16` ships an ESM
build that imports a file it does not publish, and
`@algorandfoundation/xhd-wallet-api` still asks for `^0.7.13`. Drop the pin once
`xhd-wallet-api` accepts `0.8.x`.

## Related docs

Background for the behavior above:

- [`architecture.md`](architecture.md) - pieces, deployments, and settlement
  flows
- [`campaign.md`](campaign.md) - contract state, methods, and fees
- [`claim-tree-protocol.md`](claim-tree-protocol.md) - leaf, proof, and
  refund-window rules
- [`sdk.md`](sdk.md) - the shared chain layer
- [`roadmap.md`](roadmap.md#cli) - remaining CLI work
