# @kasakame/cli

Escape-hatch CLI for kasakame: refund, cancel, and claim pledges by app ID,
using a wallet app or a local Algo25 mnemonic. Public algod + indexer only; no
backend.

Status: scaffolding. The commands and wallet login land next; see the
[CLI roadmap](../../docs/roadmap.md#cli).

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
