# @kasakame/cli

Escape-hatch CLI for kasakame: refund, withdraw, claim, and delete pledges and
campaigns by app ID, using a wallet app or a local Algo25 mnemonic. Public algod + indexer
only; no backend.

Backers withdraw or refund pledges. Creators claim or delete campaigns.

Status: all commands are implemented; CI and release land next. See the
[CLI roadmap](../../docs/roadmap.md#cli).

## Find your pledges and campaigns

```bash
node dist/index.js pledges
node dist/index.js campaigns
node dist/index.js pledges --address <address>
```

`pledges` lists every campaign where your address still holds a live pledge,
with the status, deadline, each pledge, and what you can do: `withdraw` while
the campaign is open, `refund` once it failed, or no action when it succeeded or the
refund window closed. `campaigns` lists the campaigns you created, with `claim`
or `delete` when the contract allows it.

Both commands are read-only. They print a search line while they scan the
indexer, then a table. They use the connected wallet session, the mnemonic
signer, or `--address`, and never open a signing prompt. On LocalNet and custom
networks, pass `--vault` and `--factory` so discovery can find the campaigns.

## Who can do what

`pledges` and `campaigns` are read-only and permissionless: they only read chain
state. The action column follows the address being listed. With `--address`, it
shows what that address can do; sign in with it to run the command.

- `withdraw` and `refund` need the wallet that made the pledge.
- `claim` and `delete` need the campaign creator.

The contract enforces each check, and the CLI refuses before signing when the
signer is not the owner.

## Refund (backer)

```bash
node dist/index.js refund <appId>
node dist/index.js refund <appId> --dry-run
```

`refund` returns your live pledges from a failed campaign, after its deadline
or after the creator deleted it. It rejects open and successful campaigns
before the wallet connects. With more than one live pledge, `--pledge
<position>` refunds one and `--all` refunds every one; a single pledge needs no
flag. Each pledge needs its own wallet approval, and a failed refund is
reported while the rest still run. `--dry-run` lists the pledges without
submitting anything.

## Withdraw (backer)

```bash
node dist/index.js withdraw <appId>
node dist/index.js withdraw <appId> --dry-run
```

`withdraw` takes back your live pledges while a campaign is still open, before
its deadline. It rejects campaigns that already failed or succeeded; use
`refund` after a failure. With more than one live pledge, `--pledge <position>`
withdraws one and `--all` withdraws every one; a single pledge needs no flag.
Each pledge needs its own wallet approval, and a failed withdrawal is reported
while the rest still run. `--dry-run` lists the pledges without submitting
anything.

## Claim (creator)

```bash
node dist/index.js claim <appId>
node dist/index.js claim <appId> --dry-run
```

`claim` pays a successful campaign's live total to its creator, after the
deadline. Only the creator can claim, and only once. Open, failed, and
already-claimed campaigns are rejected before anything is submitted. `--dry-run`
prints the plan without submitting.

## Delete (creator)

```bash
node dist/index.js delete <appId>
node dist/index.js delete <appId> --dry-run
```

`delete` removes a campaign and returns its schema MBR and any Factory
registration deposit to the creator. It rejects open campaigns that still hold
live pledges, and funded campaigns that are not claimed yet; claim the funds
before deleting. Deleting a failed campaign is safe: backers keep refunding from
the vault until the refund window closes. `--dry-run` prints the plan without
submitting.

## Wallet session

```bash
node dist/index.js login
node dist/index.js whoami
node dist/index.js logout
```

`login` prints a WalletConnect v1 QR; scan it with Pera or Defly, the protocol
both apps support. The session is stored in
`~/.kasakame/walletconnect/testnet.json`. The bridge comes from the list the
wallets publish (`https://wc.perawallet.app/config.json`), with a known Pera
bridge as fallback. No WalletConnect Cloud project or account is needed.

Transaction commands default to TestNet with the embedded Factory and
ClaimsVault app ids. `--vault`/`--factory` override them. LocalNet and custom
networks use `--signer mnemonic` (or default to it) and read `ALGOD_*` /
`INDEXER_*`; custom networks require `ALGOD_SERVER` and `INDEXER_SERVER`.
MainNet is not wired up yet. The mnemonic comes from `--mnemonic-file` or
`KASAKAME_MNEMONIC`, never from the command line.

## Development

```bash
npm install
npm run build
node dist/index.js --help

npm run check-types
npm run lint
npm run format
npm run test:coverage
```

Node.js 24 or newer, ESM.
