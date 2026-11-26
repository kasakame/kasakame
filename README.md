# kasakame

Non-custodial crowdfunding on Algorand. Creators open campaigns with a funding goal and a deadline; backers pledge ALGO from their own wallets. The contract enforces the outcome: if the goal is met by the deadline, the creator claims the total, otherwise each backer refunds their own pledge.

Pledged funds lock in the contract, not with the creator. Campaign state (pledged total, deadline, outcome) is public and on-chain. The application is non-custodial: it handles signed transactions only and never holds keys or funds.

## Features

| Feature | Description |
| --- | --- |
| Trustless escrow | No custodian holds funds; the contract enforces claim or refund |
| Proof-based refunds | Each pledge is a Merkle leaf; each refund is a proof; no per-backer storage |
| O(1) settlement | Success and failure paths finalize in constant time and cost |
| Post-delete refunds | Backers refund from the vault after the campaign app is deleted |
| Registry | Only hash-verified campaigns bound to the official vault accept pledges |
| Refund window | Failed pledges stay reclaimable for 730 days, then residual goes to a sweep target |

## How it works

| Piece | Responsibility |
| --- | --- |
| Campaign app (one per campaign) | Enforces rules; appends and nulls Merkle leaves; holds no funds |
| ClaimsVault (one, platform-owned) | Holds all pledged ALGO pooled; pays cancels, refunds, and claims |
| Registry (one, ownerless) | Registers campaigns against the Campaign hash fixed at creation |
| Frontend | Reads state from the indexer; builds transaction groups for the wallet |
| CLI (escape hatch) | Refunds, withdrawals, claims, and deletes by app ID; wallet or mnemonic signer |

A pledge is one atomic group: payment to the vault, campaign leaf append, vault inflow record. A refund rebuilds the leaf from address, amount, and payment ID, verifies it against the stored root, nulls it in place, and pays the backer. See [`docs/architecture.md`](docs/architecture.md) and [`docs/campaign.md`](docs/campaign.md).

## Quick start

Prerequisites: Node.js LTS (v24 or newer), Docker (LocalNet only), AlgoKit CLI.

```bash
algokit project bootstrap all  # install deps for contracts, frontend, sdk, cli, backend, utils, constants
algokit localnet start         # start algod + indexer in Docker

cd projects/contracts
npm run build          # compile contracts + generate typed clients
npm run deploy:localnet                 # deploy Registry then ClaimsVault - save both printed app ids in .env.localnet
npm run seed:localnet                   # demo data

cd ../frontend
# put the same two app ids in .env.localnet (both files start from the committed .env.<network>.template)
npm run dev:localnet   # frontend on http://localhost:5173
```

Both app ids are required. Registry registration is what lets the vault accept a
campaign's first pledge; with an empty `VITE_REGISTRY_APP_ID`, creation skips
registration, pledges are rejected, and the campaign cannot be deleted until the
id is set (see [Frontend](docs/frontend.md)).

The backend is an optional user service (wallet-signature auth, profiles/settings storage, and image/metadata pinning; a campaign catalog is planned) and runs as a separate service (see [its README](projects/backend/README.md)):

```bash
cd ../backend
cp .env.template .env  # then set SESSION_SECRET (openssl rand -hex 32) and APP_DOMAIN/APP_URI
docker compose up -d   # Postgres on localhost:5432
npm run db:migrate      # apply migrations
npm run dev             # API on http://127.0.0.1:3001
```

## Docs

| Doc | Covers |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Pieces, creation and settlement flows, tech stack |
| [`docs/campaign.md`](docs/campaign.md) | Campaign contract reference: state, methods, fees |
| [`docs/limits.md`](docs/limits.md) | AVM limits, compiled sizes, page counts, MBR, storage, and fees |
| [`docs/claim-tree-protocol.md`](docs/claim-tree-protocol.md) | Claim-tree math, proofs, and security analysis |
| [`docs/frontend.md`](docs/frontend.md) | UI structure, wallet, reads, writes, metadata |
| [`docs/cli.md`](docs/cli.md) | Escape-hatch CLI: install, signers, commands, networks, self-hosting |
| [`docs/sdk.md`](docs/sdk.md) | SDK package design and migration order |
| [`docs/testing.md`](docs/testing.md) | Contract, CLI, and frontend test strategy |
| [`docs/work-tracking.md`](docs/work-tracking.md) | Issue creation, PR linking, work-tracking automation, and verification |
| [`docs/ci.md`](docs/ci.md) | GitHub Actions workflows and checks |
| [`docs/conventions.md`](docs/conventions.md) | Lint, format, and TypeScript rules |
| [`docs/design.md`](docs/design.md) | Product decisions and open questions |

Open work is tracked in the [KasaKame project](https://github.com/orgs/kasakame/projects/1).

Agent guidance (commands, gotchas, definition of done) is in [`AGENTS.md`](AGENTS.md).

## Status

Live on TestNet. Registry [`776939068`](https://lora.algokit.io/testnet/application/776939068/), ClaimsVault [`776939077`](https://lora.algokit.io/testnet/application/776939077/). This is the v0.2.0 deployment; campaigns created on the old deployment ([`774437557`](https://lora.algokit.io/testnet/application/774437557/) / [`774437570`](https://lora.algokit.io/testnet/application/774437570/)) stay there. Current work is tracked in the [KasaKame project](https://github.com/orgs/kasakame/projects/1).

## License

MIT. See [LICENSE](LICENSE).
