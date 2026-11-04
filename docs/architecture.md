# Architecture

This page describes the system pieces, the campaign lifecycle, and the tech stack. The contract reference is in [`campaign.md`](campaign.md); the tree math is in [`claim-tree-protocol.md`](claim-tree-protocol.md); sizes, MBR, limits, and fees are in [`limits.md`](limits.md).

kasakame is a non-custodial crowdfunding dApp on Algorand. Creators open campaigns with a goal and a deadline; backers pledge ALGO from their own wallets. The UI never holds funds or keys. It reads state from the indexer and builds transaction groups that the wallet signs.

## Pieces

| Piece | Type | Role |
| --- | --- | --- |
| Campaign app | One stateful app per campaign | Enforces rules; tracks the Merkle root; holds no funds |
| ClaimsVault | One app per deployment | Holds all pledged ALGO pooled; pays cancels, refunds, and claims |
| Factory | One registry app per deployment | Registers campaigns against the deployment's owner-configured program hash and official vault |
| Frontend | React + Vite + TypeScript | Browse, create, pledge, claim, refund; wallet via Pera / Defly / Exodus (KMD on LocalNet) |
| CLI | Node.js + TypeScript | Escape hatch: refund, withdraw, claim, and delete by app ID; wallet over WalletConnect v1 or a local mnemonic (see [`cli.md`](cli.md)) |
| Catalog (optional, in progress) | Fastify + Postgres | Auth, profiles/settings, and IPFS pinning implemented; catalog, search, and history UX planned |

Users and wallets never appear as a piece: any Algorand address with a wallet is a creator or backer. No account system exists.

## Deployments

A **deployment** is one Factory, one ClaimsVault, and one Campaign
approval-program version, with its own app IDs and owner. Anyone can deploy the
contracts and become that deployment's owner. The TestNet app IDs in this repo
describe one deployment; other deployments use their own IDs.

`Factory.isRegistered(app)` answers whether the app is registered in that
specific Factory. Clients choose which deployments they trust by pinning the
Factory and vault app IDs; the SDK takes `factoryAppId` and `vaultAppId` as
config. Each Factory's owner decides which campaign program that deployment
admits, and binds the deployment's official ClaimsVault with `setVault` (owner-only,
one-time) after the vault is deployed; the vault must point back at the same Factory,
so a wrong or foreign vault cannot be bound. The planned standard defines the interface
and behavior and leaves the choice of deployment to clients.

Deployment setup order: deploy the Factory, deploy the ClaimsVault with the Factory
id, then call `Factory.setVault(vault)` as the Factory owner. A new vault therefore
requires a new Factory. On TestNet/MainNet, set `SWEEP_TARGET` explicitly; LocalNet
defaults the residual sweep to the deployer.

## Creation flow

To open a campaign, complete these steps in order:

1. Deploy a Campaign app with the **official vault**, title, metadata URI, goal, and deadline.
2. Pay the 18,900 µA registration deposit to the Factory.
3. Register the app in the deployment's Factory so clients that trust that
   deployment list it.
4. Share the app ID so backers find it through the deployment's Factory listing.

The registration group is `[deposit payment, Factory.register]` with `register` as the final transaction. The contract rejects
other shapes, so one deposit cannot register more than one campaign. `register` also reads the campaign's `vault` global and
rejects a campaign bound to any vault other than the Factory's official one.

`Factory.unregister` only accepts a campaign that is settled (`Claimed`/`Failed`), pristine (`Open` with `raised == 0`), or
failed-in-fact (`Open`, deadline passed, `raised < goal`), and it requires the campaign's `delete()` to be the immediately
following transaction in the same atomic group. The campaign's side requires that `unregister` (a NoOp call) immediately before
`delete` when its vault has a Factory binding, so a raw delete of an official campaign is rejected. Delisting and deletion are
therefore one operation: a delisted campaign can never remain live, and zero-pledge or all-cancelled campaigns clean up
immediately. Unregister runs first because the campaign state must be read before the app is deleted. An unregistered
campaign's `unregister` is a no-op (still shaped with the delete next), so the same group cleans up a registration that never
landed.

The frontend chains steps 1 through 3 into a single user action (see [`frontend.md`](frontend.md)). The current create cost is
**589,900 µA (~0.59 ALGO) locked** (571,000 µA campaign app MBR + 18,900 µA registration deposit) plus ~5,000 µA in transaction
fees; the app MBR and deposit are returned by the atomic `[unregister, delete]` group. The vault box MBR (32,100 µA) is paid by
the vault on first pledge, not by the creator. See [`limits.md`](limits.md).

## Escrow and vault

Campaign escrows are never funded and hold nothing. Every pledge payment goes to the vault app account. Each pledge appends one receipt leaf to the campaign's incremental Merkle tree ([`claim-tree-protocol.md`](claim-tree-protocol.md)) and records the inflow in the vault's per-campaign box. `Vault.credit` requires the campaign's `pledge` as the immediately preceding transaction, and both calls must be `NoOp` (`ClearState` bypasses the method), so every inflow has a backer leaf and there are no standalone donations. There is no per-backer on-chain state anywhere.

The vault account therefore holds the full pool of live pledges plus parked box minimum balances (32,100 µA per live or failed campaign box). Every outflow passes a balance guard: a payout never exceeds the campaign's verified inflows minus its verified outflows.

## Settlement flows

| Path | Trigger | Effect |
| --- | --- | --- |
| Success | Creator calls `claim()` after the deadline with the goal met | Vault pays the creator the full live total; the box closes as `Claimed` |
| Failure | First `refund()` after the deadline with the goal missed | Box settles as `Failed`; each backer refunds their own leaves from the vault |
| Pre-deadline exit | Backer calls `cancelPledge()` while the campaign is open | Leaf nulls in place; vault pays the backer |
| Creator delete | Creator submits `[Factory.unregister, Campaign.delete]` | Unregister checks settled/pristine/failed-in-fact and returns the deposit (no-op if unregistered); the campaign requires that unregister immediately before, then delete settles through the vault, closes the escrow, and deletes the app |

Both settlement paths finalize in O(1) time and cost. Refunds stay available for 730 days after settlement then a permissionless `finalize()` sweeps the residual to the configured treasury; a fully paid-out box can be finalized immediately. A backer who never acts before deletion refunds straight from the vault with the same proofs.

## Optional catalog

The Factory plus the indexer already cover discovery (which campaigns exist) and the outcome record (what happened). The backend (`projects/backend`, Fastify + Postgres) implements wallet-signature auth, profiles/settings CRUD, and authenticated image and metadata uploads pinned to IPFS (`POST /uploads`, `POST /uploads/metadata`); the per-campaign catalog row with its chain watcher and the creator updates feed are planned (see [`roadmap.md`](roadmap.md)). It never holds keys, funds, or outcome decisions. Without it the dApp still runs.

## Tech stack

| Layer | Choice |
| --- | --- |
| Contracts | Algorand TypeScript (PuyaTs) via AlgoKit, TEAL + ARC-32/56 specs as build output |
| Client SDK | AlgoKit Utils `AlgorandClient` + generated typed clients |
| Wallet | `@txnlab/use-wallet` + `@perawallet/use-wallet-pera` (Pera, Defly, Exodus; KMD on LocalNet) |
| CLI | Node.js + `@kasakame/sdk`; WalletConnect v1 (`@perawallet/walletconnect`) or a local mnemonic |
| Reads | `algosdk.Indexer` for app state, boxes, and transaction history |
| Frontend tests | Vitest + Testing Library, 100% gate on components and utils |
| Contract tests | Offline AVM emulation plus LocalNet integration (see [`testing.md`](testing.md)) |
| CI | One `build-and-test` workflow with per-change lanes (contracts, SDK, frontend, CLI, backend, shell, Markdown) plus the manual release workflows (see [`ci.md`](ci.md)) |

## Constraints

- Discovery needs no backend. For a given deployment, the Factory registry plus the indexer answer "which campaigns exist" today.
- The contract is the source of truth. The frontend computes display status from the same public state, and the contract assertions decide.
- Pledge-time content stays frozen. `title` and `metadataUri` are immutable, so a pledge can never be re-described under the backer. Corrections ship through the creator updates feed (see [`design.md`](design.md)).
