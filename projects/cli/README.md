# @kasakame/cli

Escape-hatch CLI for kasakame: refund, cancel, claim, and delete campaigns by
app ID, using a wallet app or a local Algo25 mnemonic. Public algod + indexer
only; no backend.

Backers cancel or refund pledges. Creators claim or delete campaigns.

Status: `refund`, `cancel`, `claim`, and `delete` are implemented; discovery,
CI, and release land next. See the [CLI roadmap](../../docs/roadmap.md#cli).

## Refund (backer)

```bash
node dist/index.js refund <appId>
node dist/index.js refund <appId> --dry-run
```

`refund` returns every live pledge from a failed campaign, after its deadline
or after the creator deleted it. It rejects open and successful campaigns
before the wallet connects. Each pledge needs its own wallet approval, and a
failed refund is reported while the rest still run. `--dry-run` lists the
pledges without submitting anything.

## Cancel (backer)

```bash
node dist/index.js cancel <appId>
node dist/index.js cancel <appId> --dry-run
```

`cancel` withdraws every live pledge while a campaign is still open, before its
deadline. It rejects campaigns that already failed or succeeded; use `refund`
after a failure. Each pledge needs its own wallet approval, and a failed
cancellation is reported while the rest still run. `--dry-run` lists the
pledges without submitting anything.

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

`login` prints a WalletConnect QR; scan it with Pera, Defly, or another
Algorand WalletConnect wallet. The session is stored under
`~/.kasakame/walletconnect/`. The package embeds the public WalletConnect
project ID; set `KASAKAME_WALLETCONNECT_PROJECT_ID` to use your own.

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
