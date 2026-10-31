# @kasakame/cli

Escape-hatch CLI for kasakame: refund, cancel, and claim pledges by app ID,
using a wallet app or a local Algo25 mnemonic. Public algod + indexer only; no
backend.

Status: wallet session commands (`login`, `whoami`, `logout`) are implemented;
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
