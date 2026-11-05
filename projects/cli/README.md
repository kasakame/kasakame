# @kasakame/cli

Escape-hatch CLI for [kasakame](https://github.com/kasakame/kasakame), a
non-custodial crowdfunding dApp on Algorand. Refund, withdraw, claim, and delete
pledges and campaigns by app ID from a terminal, using a wallet app or a local
mnemonic. It reads public algod and indexer endpoints and talks to no kasakame
backend, so an exit never depends on our servers.

## Install

Requires Node.js 24 or newer.

```bash
npm install --global @kasakame/cli
kasakame --help
```

Run a one-off with `npx @kasakame/cli --help`.

## Commands

| Command            | Description                                       |
| ------------------ | ------------------------------------------------- |
| `pledges`          | List your live pledges and the action to take     |
| `campaigns`        | List campaigns you created and the action to take |
| `refund <appId>`   | Refund your pledges from a failed campaign        |
| `withdraw <appId>` | Take back your pledges while a campaign is open   |
| `claim <appId>`    | Claim a successful campaign as its creator        |
| `delete <appId>`   | Delete a campaign and reclaim its deposit         |
| `login`            | Pair a wallet over WalletConnect                  |
| `whoami`           | Show the signer address                           |
| `logout`           | Disconnect the stored wallet session              |

## Discover pledges and campaigns

```bash
kasakame pledges
kasakame campaigns
kasakame pledges --address <address>
```

`pledges` lists every campaign where the address holds a live pledge, with the
status, deadline, and each pledge. `campaigns` lists the campaigns the address
created. Without `--address`, the tables also show the action the signer can
run: `withdraw` while open, `refund` once failed. With `--address`, they show
state only.

Both commands are read-only. They print a search line while they scan the
indexer, then a table. They use the connected wallet session, the mnemonic
signer, or `--address`, and never open a signing prompt. On LocalNet and custom
networks, pass `--vault` and `--factory` so discovery can find the campaigns.

## Who can do what

Reads are permissionless: `pledges` and `campaigns` only read chain state.

- `withdraw` and `refund` have no creator gate, but the Merkle proof is built
  from the caller's address. Only the wallet that made the pledge can produce
  it; nobody can withdraw someone else's pledge.
- `claim` and `delete` are creator-only.

Without `--address`, discovery uses the signer's address and shows the actions
that signer can run. With `--address`, it is a state-only read-only view: every
write needs the creator's or the pledge owner's wallet.

## Refund a pledge

```bash
kasakame refund <appId>
kasakame refund <appId> --dry-run
```

`refund` returns your live pledges from a failed campaign, after its deadline
or after the creator deleted it. It rejects open and successful campaigns
before the wallet connects. With more than one live pledge, `--pledge
<position>` refunds one and `--all` refunds every one; a single pledge needs no
flag. Each pledge needs its own wallet approval, and a failed refund is
reported while the rest still run. `--dry-run` lists the pledges without
submitting anything.

## Withdraw a pledge

```bash
kasakame withdraw <appId>
kasakame withdraw <appId> --dry-run
```

`withdraw` takes back your live pledges while a campaign is still open, before
its deadline. It rejects campaigns that already failed or succeeded; use
`refund` after a failure. With more than one live pledge, `--pledge <position>`
withdraws one and `--all` withdraws every one; a single pledge needs no flag.
Each pledge needs its own wallet approval, and a failed withdrawal is reported
while the rest still run. `--dry-run` lists the pledges without submitting
anything.

## Claim a campaign

```bash
kasakame claim <appId>
kasakame claim <appId> --dry-run
```

`claim` pays a successful campaign's live total to its creator, after the
deadline. Only the creator can claim, and only once. Open, failed, and
already-claimed campaigns are rejected before anything is submitted. `--dry-run`
prints the plan without submitting.

## Delete a campaign

```bash
kasakame delete <appId>
kasakame delete <appId> --dry-run
```

`delete` removes a campaign and returns its schema MBR and any Factory
registration deposit to the creator. It rejects open campaigns that still hold
live pledges, and funded campaigns that are not claimed yet; claim the funds
before deleting. Deleting a failed campaign is safe: backers keep refunding from
the vault until the refund window closes. `--dry-run` prints the plan without
submitting.

## Wallet session

```bash
kasakame login
kasakame whoami
kasakame logout
```

`login` prints a WalletConnect v1 QR; scan it with Pera or Defly, the protocol
both apps support. The session is stored in
`~/.kasakame/walletconnect/testnet.json`. The bridge comes from the list the
wallets publish (`https://wc.perawallet.app/config.json`), with a known Pera
bridge as fallback. No WalletConnect Cloud project or account is needed.

## Networks and signers

Transaction commands default to TestNet with the embedded Factory and
ClaimsVault app ids. `--vault`/`--factory` override them.

LocalNet and custom networks use `--signer mnemonic` (or default to it) and read
`ALGOD_*` / `INDEXER_*`; custom networks require `ALGOD_SERVER` and
`INDEXER_SERVER`. MainNet is not wired up yet.

The mnemonic comes from `--mnemonic-file` or `KASAKAME_MNEMONIC`, never from the
command line. A 25-word Algo25 phrase signs for its own address; pass
`--address` to check that it matches. A 24-word Pera Universal Wallet phrase
derives accounts through ARC-52, so `--address` is required to pick which one
signs:

```bash
kasakame refund <appId> --signer mnemonic --mnemonic-file ./phrase.txt --address <address>
```

## Documentation

The [CLI guide](https://github.com/kasakame/kasakame/blob/main/docs/cli.md)
covers install, signers, commands, networks, and self-hosting. The
[kasakame repository](https://github.com/kasakame/kasakame) has the full docs
and source.

## License

MIT. See [LICENSE](https://github.com/kasakame/kasakame/blob/main/projects/cli/LICENSE).
