# @kasakame/cli

Escape-hatch CLI for kasakame: refund, cancel, and claim pledges by app ID,
using a wallet app or a local Algo25 mnemonic. Public algod + indexer only; no
backend.

Status: flags, network/app-id overrides, and both signer paths are in place;
refund/cancel/claim land next. See the [CLI roadmap](../../docs/roadmap.md#cli).

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
