# AGENTS.md

Guidance for AI coding agents (and contributors) working in this repository.

## What this is

kasakame is a non-custodial crowdfunding dApp on Algorand, built as an AlgoKit
workspace: an Algorand TypeScript smart contract plus a React + Vite frontend.

## Layout

- `projects/contracts/` - AlgoKit contract project (Algorand TypeScript → AVM)
  - `deploy/` - deploy runner, deployer-account resolution, Registry/Vault deploy configs, and refund-window/sweep-target parsing
  - `scripts/` - demo seed/unseed (`demo/`) and the LocalNet clock/funding helpers
  - `test/` - LocalNet suites (`00-deploy`, `01-single-campaign`, ...), run in path order
  - `test/utils/` - contract-only LocalNet fixtures, campaign flows, the reference-oracle wrapper and `oracle.py`, scale knobs, and the compiled-size snapshot
  - `test/formulas.spec.ts`, `test/08-size-budget.spec.ts` - offline pins for the fee formulas, embedded selectors, compiled size, and app MBR
  - `smart_contracts/campaign/contract.algo.ts` - the `Campaign` app
    (`create`, `pledge`, `cancelPledge`, `refund`, `claim`, `delete`); its
    escrow is never funded and holds nothing
  - `smart_contracts/claimsvault/contract.algo.ts` - the `ClaimsVault`: pooled
    refund escrow (`create`, `credit`, `payBack`, `payClaim`, `settle`,
    `settleOpen`, `refund`, `notifyDelete`, `releaseClaimed`, `finalize`)
  - `smart_contracts/registry/contract.algo.ts` - the ownerless on-chain `Registry`
    (Campaign and Vault program hashes, sweep target, and refund window fixed at
    `create`; permissionless one-time `bindVault`; `register`/`unregister`, readonly
    `isRegistered`)
  - `smart_contracts/artifacts/` - **generated** (compiled TEAL, ARC-32/56 specs, clients)
- `projects/frontend/` - React + Vite + TypeScript dApp
- `projects/utils/` - private `@kasakame/utils` repo helpers: the `.` entry holds
  production-neutral hash/selector/bytes helpers, `./testing` holds LocalNet
  deploy/ledger helpers. Never published; consumers link it with a `file:`
  dependency. See [`projects/utils/README.md`](projects/utils/README.md).
- `projects/constants/` - public `@kasakame/constants` protocol, fee, and AVM
  values. The `.` entry is the compiled package; `./source` is the TypeScript
  source the contract compiler imports. One `src/index.ts`; `dist` is committed
  so consumers can install the package without a build step. See
  [`projects/constants/README.md`](projects/constants/README.md).
- `projects/sdk/` - `@kasakame/sdk`: claim-tree math, campaign reads, and
  transaction assembly (the chain layer the frontend consumes); see
  [`docs/sdk.md`](docs/sdk.md) for the migration order
- `projects/cli/` - `@kasakame/cli`: standalone escape-hatch CLI
  (refund/withdraw/claim/delete by app ID; wallet or mnemonic signing); see
  [`docs/cli.md`](docs/cli.md)
- `projects/backend/` - optional Fastify + Postgres user service (wallet-signature auth, profiles/settings storage, pinning and catalog)
- [`docs/`](docs/) - technical docs: [`architecture.md`](docs/architecture.md)
  (overview), [`campaign.md`](docs/campaign.md) (contract reference),
  [`claim-tree-protocol.md`](docs/claim-tree-protocol.md) (tree math and
  security), [`frontend.md`](docs/frontend.md), [`cli.md`](docs/cli.md)
  (escape-hatch CLI: signers, commands, networks, self-hosting),
  [`sdk.md`](docs/sdk.md) (SDK package design and migration order),
  [`testing.md`](docs/testing.md),
  [`ci.md`](docs/ci.md), [`conventions.md`](docs/conventions.md)
  (lint/format/tsconfig rules), [`design.md`](docs/design.md) (product plan)
- `.github/ISSUE_TEMPLATE/` - issue forms for Task, Bug, Feature, Epic, and Component
- [`README.md`](README.md) - project overview, quick start, and docs map

## Commands

Run from the repo root unless noted.

```bash
algokit project bootstrap all    # install deps for contracts + frontend + sdk + cli + backend + utils + constants
algokit localnet start           # start algod + indexer (Docker)

npx --yes markdownlint-cli2@0.23.2        # markdownlint across all docs (add --fix to autofix)
git ls-files -z '*.sh' '*.bash' | xargs -0 -r shellcheck  # ShellCheck all tracked shell scripts

cd projects/contracts
npm run build                    # compile contracts + generate typed clients
npm run check-types              # tsc --noEmit
npm run lint                     # ESLint (also: npm run lint:fix)
npm run format                   # Prettier check (also: npm run format:fix)
npm run test:integration         # LocalNet integration lane (PR gate)
npm run test:cap:failed          # cap-scale failed campaign (heavy-tests workflow, CI only)
npm run test:cap:claimed         # cap-scale claimed campaign (heavy-tests workflow, CI only)
npm run localnet:advance         # shift the LocalNet clock (SECONDS=...)
npm run localnet:fund            # fund an address from the dispenser (ADDRESS=..., ALGO=...)
npx vitest list test -t "<ID>"  # find the file that owns a test ID
npx vitest run test -t "<ID>"   # one test by ID (chain tests need the whole file)

cd ../utils
npm run check-types              # tsc --noEmit
npm run lint                     # ESLint
npm run format                   # Prettier check

cd ../constants
npm run build                    # tsc emit to dist
npm run check-types              # tsc --noEmit
npm run lint                     # ESLint
npm run format                   # Prettier check

cd ../frontend
npm run dev:localnet             # Vite with the LocalNet env (published SDK)
npm run check-types              # tsc --noEmit
npm run lint                     # ESLint (+ react/react-hooks plugins)
npm run format                   # Prettier check

cd ../sdk
npm run build                    # codegen + tsc emit to dist (needs @kasakame/contracts; SDK_SPECS=local uses the contracts build)
npm run codegen                  # regenerate clients from @kasakame/contracts
npm pack --dry-run               # inspect the published package contents
npm run check-types              # tsc --noEmit
npm run lint                     # ESLint
npm run format                   # Prettier check
npm run test:integration         # LocalNet (requires algokit localnet start + generated clients for the target contracts)

cd ../cli
npm run build                    # tsc emit to dist
npm run check-types              # tsc --noEmit
npm run lint                     # ESLint
npm run format                   # Prettier check
npm run test:coverage            # Vitest

cd ../backend                    # optional API; Postgres via docker compose
npm run db:migrate               # apply migrations
npm run dev                      # Fastify in watch mode
npm run check-types              # tsc --noEmit
npm run lint                     # ESLint
npm run format                   # Prettier check
```

Or from the repo root: `algokit project run lint` / `algokit project run format` /
`algokit project run check-types` applies to every project in the workspace.

## How to work

- Read [`README.md`](README.md) and the relevant file under [`docs/`](docs/) **before**
  changing behavior.
- **Issue first, then branch, then PR.** Create the issue before the branch, then
  create the branch with `gh issue develop <N> --name type/N-slug --checkout`, then
  open the PR from it. The linked branch attaches the PR to the issue and closes
  it on merge, so no `Closes`/`Fixes` keyword is needed. Never push to `main`. Do
  not create worktrees or merge a PR without explicit approval.
- The contract is the source of truth; the indexer is only a read model.
- **Preserve the six protocol requirements.** Any change must keep the A–F scorecard in
  [`claim-tree-protocol.md`](docs/claim-tree-protocol.md) §18 satisfied; update the scorecard in the
  same change set if a change deliberately trades one off.
- **Keep the UI normal.** Never surface chain or storage internals (CIDs, hashes, hand-authored JSON,
  transaction mechanics) in the interface, and never send users to external tools to shuttle data
  back in. Approvals follow user intent: one click, only the approvals the protocol structurally requires.
- **Successful-campaign creator inactivity is accepted product behavior.** A successful campaign's
  creator must claim; if they disappear, the funds stay locked and backers cannot refund. Do not add
  a protocol fallback, do not sweep successful campaigns to the platform, and do not treat this as a
  bug. Notifications may remind the creator later. The failed-campaign refund window is a different
  path and does not apply here.
- **Confirm assumptions against real documentation.** Algorand behavior (box MBR,
  app lifecycle, indexer retention, transaction semantics, inner-txn fees) changes
  over time and is easy to misremember. Do not assert how the chain works from
  memory - check the official Algorand docs (see [References](#references)) before
  writing docs or code that depends on a protocol detail, and cite the source in
  the docs. When the docs are ambiguous, test on LocalNet rather than guessing.
- When you edit any Markdown file, lint it with the command in
  [Commands](#commands).

## Contract size, storage, and fees

The compiled size, page count, app MBR, box MBR, and transaction fees are part of
the product contract. The pinned values and the AVM limits are in
[`docs/limits.md`](docs/limits.md); read it before touching
`smart_contracts/**/contract.algo.ts`.

- **Measure before and after.** Run `npm run build` in `projects/contracts`,
  record the approval/clear bytecode sizes, page count, app MBR, box MBR, and the
  affected group fees, and update `docs/limits.md` plus the affected docs in the
  same change set. The report command is in
  [`docs/limits.md`](docs/limits.md#measure-the-current-sizes).
- **The size budget is pinned.** `npm run test:size` asserts the compiled bytes,
  pages, global schema, and app MBR in
  `test/utils/size-budget.fixture.ts`; it runs in the `compile-contracts` CI
  job after `npm run build`. Update the snapshot and `docs/limits.md` together.
- **The product input bounds are pinned.** Goal, pledge, refund window, and
  registration deposit bounds live in [`docs/limits.md`](docs/limits.md) and the
  contracts. `raised` and `paidIn` have explicit uint64 overflow guards; there is
  no product cumulative-flow cap. Update `docs/limits.md` and the SDK/frontend
  constants with any change.
- **The claim-tree size is capped at 2¹⁹ − 1.** The worst-case refund path needs
  the full OpUp budget: the ABI router and guards consume part of the 700 base
  opcodes, and the SDK's zero-headroom fee bound funds the takes so groups never
  underpay. The boundary ladder in the integration suite proves the prelude
  leaves enough ops for the cap; if a contract change breaks that guard,
  re-measure and lower the cap. `MAX_TREE_SIZE` lives in
  `@kasakame/constants`; Campaign, ClaimsVault, Registry, and the SDK import it.
  The cap counts every appended position, including cancelled leaves. The
  heavy-tests workflow runs the cap-scale suites end to end; never run them
  locally in a normal change.
- **Never silently change the creator cost.** The campaign create cost is a
  product promise; the pinned MBR and fee values live in
  [`docs/limits.md`](docs/limits.md). If a change crosses a page boundary, adds a
  global/local slot, adds a box, adds an inner txn to create/register, or changes
  a group shape or fee, stop and call it out in the commit/PR; get explicit
  approval before proceeding.
- **Any campaign program change changes the Registry `campaignProgramHash`.**
  Update the deploy script, tests, docs, contracts/SDK release, and deploy a new
  Registry + Vault bundle. The hash is
  `sha256(itob(approval.length) ‖ approval ‖ clear)`; the 8-byte length prefix
  binds the approval/clear split. The Campaign hash, Vault hash, sweep target,
  and refund window are fixed at Registry `create`; there is no in-place update
  or timelock. The vault is bound once and checked in `bindVault`.
- **Locked is not spent.** App/box MBR and the registration deposit are locked
  and recoverable; transaction fees are spent. [`docs/limits.md`](docs/limits.md)
  records which side funds each box and account balance.
- **Respect the no-surcharge page limit.** The pinned limit is in
  [`docs/limits.md`](docs/limits.md). Do not rely on the surcharge path unless the
  target network supports it and the cost is accepted.
- **Keep the vault and Registry funded.** New boxes increase their accounts'
  minimum balances. Check the group and resource limits in
  [`docs/limits.md`](docs/limits.md) when adding a call, box, or reference.

## Conventions

- **The shared utils package is repo-local.** `projects/utils` is private and
  never published; contracts and the SDK install it with a `file:../utils`
  dependency, and AlgoKit bootstrap discovers its `.algokit.toml`. The consumer
  `.npmrc` sets `install-links = true` so npm packs the package into the
  consumer's `node_modules` with its dependencies; re-run `npm install` after
  editing it. Its exports point at TypeScript sources, so there is no build step:
  run `npm run check-types`/`lint`/`format` in the package. Generic LocalNet
  helpers belong in `@kasakame/utils/testing`; contract-only helpers stay in
  `projects/contracts/test/utils`.
- **The shared constants package has two entry points.** `@kasakame/constants`
  is the compiled runtime package; `@kasakame/constants/source` is the
  TypeScript source for the Puya contract compiler. Contracts import `/source`;
  SDK, CLI, frontend, and test helpers import the package name. Keep
  `projects/constants/src/index.ts` a single file with direct `export const`
  declarations: Puya does not support re-export declarations or `BigInt()` in
  that source. `dist` is committed: rebuild it with `src` and commit both in the
  same change; `check-constants` rebuilds and fails when the committed output
  drifts.
- **Generated files are gitignored.** `smart_contracts/artifacts/` (compiled TEAL, specs,
  `*Client.ts`) and the SDK's `src/generated/` clients are build outputs - never edit or
  commit them. Rebuild instead (`npm run build` in `projects/contracts`; `npm run codegen` in
  `projects/sdk`). The one exception is `projects/constants/dist`, which is committed so
  file-dependency consumers can install the constants package without a build step.
- **The frontend consumes the published SDK.** `projects/frontend` depends on
  the published `@kasakame/sdk`; check its `package.json` for the current range.
  To test unreleased contracts/SDK changes, build the SDK (`npm run build` in
  `projects/sdk`) and install it as a packed local copy
  (`npm install --no-save --install-links "file:../sdk"` in
  `projects/frontend`) - a plain `npm ci` restores the published package. CI
  installs the same copy only when the SDK or contracts changed; other frontend
  runs test the registry package. The CLI (`projects/cli`) consumes the same
  published package and follows the same packed-copy pattern for unreleased SDK
  changes.
- **The SDK builds against the published contracts package.** The
  `@kasakame/contracts` version in `projects/contracts/package.json` is installed and
  codegen reads `node_modules/@kasakame/contracts/dist/arc56`, then regenerates clients
  with the pinned generator. The version is exported as `SPECS_VERSION`.
  `SDK_SPECS=local` reads `projects/contracts/smart_contracts/artifacts` instead -
  contracts-changed CI lanes and local contract work use it. The `release-contracts`
  workflow publishes the `contracts-vX.Y.Z` GitHub release and the npm package from the
  same build. Never copy clients between projects.
- **Never commit secrets.** `.env` files are gitignored; mnemonics/API keys never go in code.
- **Env files are per network, never a shared `.env`.** Commands name their network
  explicitly (`.env.localnet` / `.env.testnet`; for example, `npm run dev:testnet`
  and `npm run seed:testnet`; `algokit project deploy <network>` maps to the matching command in
  `.algokit.toml`). The committed `.env.<network>.template` files document the shape, and
  `algokit project bootstrap all` creates the matching `.env.<network>` from them when missing -
  never a base `.env`, since Vite layers `.env` underneath `.env.<mode>`.
  Add `.env.mainnet` when MainNet is wired, using the same pattern.
- **Lint, format, and compiler rules** (ESLint, Prettier, and `tsconfig.json` options)
  are documented in [`docs/conventions.md`](docs/conventions.md).
- **Algorand TypeScript gotchas** (contracts use `@algorandfoundation/algorand-typescript`):
  - `assert` must be imported explicitly - it is not a global.
  - `GlobalState`/`BoxMap` class properties require the options object
    (for example, `BoxMap<Account, uint64>({ keyPrefix: 'p' })`).
  - Create-time methods use `@abimethod({ onCreate: 'require' })`.
  - Reading a `BoxMap` entry `.value` fails if the box is missing - use
    `.get({ default: 0 })` for first-write patterns.
  - ABI payment arguments are `gtxn.PaymentTxn`; asset-transfer arguments are
    `gtxn.AssetTransferTxn`; the escrow address is
    `Global.currentApplicationAddress`.
  - An asset id is stored in global state as a plain `uint64` (`GlobalState<uint64>`)
    and wrapped with `Asset(...)` where a reference type is needed.
  - Inner asset transactions (`itxn.assetTransfer`/`itxn.assetConfig`) and
    `op.AssetHolding.assetBalance` require the asset to be in the **outer call's
    foreign assets** - the frontend passes `assetReferences: [assetId]` (grouped
    gtxn transfers pool their own assets, so `refund(axfer)` needs none).
  - Destroy an ASA with `itxn.assetConfig({ configAsset, fee: Uint64(0) })` (no
    other fields) - only valid when the creator account holds the full supply.
  - **Box access needs declared references on the outer txn** (AVM): inner app
    calls that read/write another app's BoxMaps fail with "invalid Box
    reference" unless `boxReferences` lists the box names. Keep BoxMap keys
    derivable from ABI args so `populateAppCallResources` can fill them; names
    derived from inner-created ids (for example, a created asset id) can never be
    declared - avoid that keying.
  - Inner app calls use raw ARC-4 selectors (the emitted signatures flatten
    `Application`→`uint64`, `Account`→`address`) - compute them from the emitted
    ARC-56 and keep them in sync with a test. A readonly bool return arrives as
    the inner call's `lastLog`: the ARC-4 prefix `0x151f7c75` + `0x80`/`0x00`.
  - **User actions are top-level only.** `Campaign.create/pledge/cancelPledge/refund/claim/delete`,
    `Vault.create/credit/refund/settleOpen/finalize/releaseClaimed`, and
    `Registry.create/register/unregister` assert `Global.callerApplicationId == 0`.
    The campaign-driven vault methods (`payBack`, `payClaim`, `settle`, `notifyDelete`)
    and `Registry.isRegistered` stay inner-callable; do not add the guard there. The
    SDK replay depends on top-level pledges and payments.
  - **Cap-saturated campaigns fail early.** At `n == MAX_TREE_SIZE` with `raised < goal`,
    `Vault.settleOpen` settles before the deadline, and `Campaign.delete` plus
    `Registry.unregister` treat the campaign as failed-in-fact. The cap lives in
    `@kasakame/constants` and Campaign, ClaimsVault, Registry, and the SDK import
    it.
  - **Final-day goal protection.** `Campaign.cancelPledge` rejects a cancel in the final
    24 hours that would drop a campaign at or above its goal below the goal. Cancels
    that keep the goal, and cancels in an already-below-goal campaign, are allowed;
    `refund` is unaffected. A one-day campaign is entirely inside the window.
  - `app_global_get_ex` **fails on deleted apps** (not exists=false) - never
    make vault logic depend on reading a possibly-deleted campaign's state; use
    vault-local markers written by the campaign (for example, the `root`/`N`/`settledAt`
    fields `settle` writes into the campaign box) instead.
  - Box MBR: a box written by an app is charged to that app's account - the
    Registry app account must be platform-funded before `register()` can write
    its registration box.
  - A zero-amount asset transfer only opts a receiver in when sender == receiver
    (self-opt-in); one app cannot opt another account in on its behalf.
  - Reading a foreign app's global state works via
    `op.AppGlobal.getExUint64/getExBytes(app, key)`; foreign **box** reads have
    no opcode - derive lookups from caller-supplied ids verified against local
    mappings instead.
  - **Payment-consuming group order is load-bearing.** The payment must be the
    transaction immediately before `Campaign.pledge`; the matching `Vault.credit`
    must be immediately after the pledge and the group's final transaction, and
    the vault requires that pledge immediately before it. `Registry.register` must
    also be final. `Registry.unregister` must be immediately followed by the
    campaign's `delete()`, and the campaign's `delete()` requires that
    `unregister` immediately before it (when the campaign's vault has a Registry
    binding). The paired calls must be `NoOp`: a `ClearState` call runs the
    clear-state program instead of the method, so it can satisfy an app-id/selector
    check without executing the paired logic. The contracts reject other shapes; the
    positions stop one payment from backing several pledges, credits, or
    registrations, stop a pledge from being left uncredited, stop a credit without a
    pledge (donations), and make delisting and deletion one operation.
  - `Registry.unregister` requires the campaign creator. A registered campaign
    must exist and be settled (`Claimed`/`Failed`), pristine (`Open`,
    `raised == 0`), or failed-in-fact; an unregistered campaign is a no-op, so the
    same cleanup group also handles a registration that never landed. The
    campaign's `delete()` must be the immediately following transaction:
    unregister reads the state first, the delete then settles/releases the box.
    The campaign's side enforces the reverse (unregister immediately before), so
    a raw delete of an official campaign is rejected.
- **Keep docs aligned.** Whenever a change affects behavior, structure, commands, or
  conventions, update the relevant docs in the same change set:
  - `docs/` for technical details and design decisions
  - `README.md` for spec-level behavior, the status summary, and getting-started steps
  - `AGENTS.md` (this file) for commands, conventions, and agent-facing guidance
  If the change doesn't affect these, no doc update is needed.
- **Package READMEs are user-facing.** `projects/constants`, `projects/contracts`,
  `projects/sdk`, and `projects/cli` publish their READMEs to npm. Use the same
  shape in each: title and one-line description, `## Install` with the Node
  requirement and peer dependencies, package-specific usage, `## Documentation`
  links, and a `## License` footer with the same `MIT. See
  [LICENSE](.../projects/<package>/LICENSE).` wording. Repository status, work
  tracking, and contributor instructions belong in the root README or `docs/`.
- **Published package metadata matches.** Each published package declares
  `author`, `description`, `keywords`, `license`, `repository.directory`,
  `homepage`, `bugs`, `engines`, `publishConfig.access: public`, and a `files`
  allowlist; the LICENSE files are identical. The release workflows pack and
  smoke-test the tarballs.

## Testing

- Contracts: simulator tests for full behavioral coverage (every method × every branch).
- Contract cap scale: the cap-scale suites fill the maximum tree and run only in
  the separate `heavy-tests` workflow (scheduled and manual); do not run them
  locally.
- SDK: offline Vitest with 100% coverage plus the LocalNet send-path suite
  (`npm run test:integration`; see [`docs/testing.md`](docs/testing.md#sdk-localnet-integration)).
- Frontend: Vitest, with line coverage at 100% on components and utils.
- Add or update tests in the same change set as the code they cover.

## Definition of done

A ticket is done when its acceptance criteria are met and the PR that links it
is merged. The `gh issue develop` branch closes the issue on merge; close it
manually only if it is still open. Before opening the PR, run the checks from
[Commands](#commands) in order - format, lint, check-types, then the relevant test
suite - and fix everything until green. Don't skip a step because the change
"looks small."

For contract changes, also run `npm run build` in `projects/contracts`, record the
size/page/MBR/fee deltas, and update [`docs/limits.md`](docs/limits.md) (see
[Contract size, storage, and fees](#contract-size-storage-and-fees)).

## Commits & pull requests

- **Never commit or push automatically** unless asked; always propose a commit message first.
- **Branch naming:** `type/issue-number-slug`, for example `feat/42-backer-banner`.
  Use the commit type as the prefix and the issue number after it.
- Follow **Conventional Commits**: `<type>(<scope>): <description>`
  - Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, `style`
  - Scopes: `contracts`, `frontend`, `sdk`, `cli`, `backend`, `ci`, `infra`, `docs`,
    `maintenance` (the components). Omit the scope when a change spans several.
  - Description is imperative and ≤ 72 chars.
  - No body unless needed; when present, explain the "why" as a short bullet list.
  - Example: `feat(contracts): add pledge escrow contract`.
- **Pull requests** use the template in [`.github/pull_request_template.md`](.github/pull_request_template.md):
  - The title is the change name in Conventional Commit form.
  - List the issue in the **Related issues** section, for example `#N`. The
    `gh issue develop` branch links the PR and closes the issue on merge; do not
    add a `Closes`/`Fixes` keyword. Close it after merge only if it is still open.
  - One issue per PR; squash merge. Do not merge a PR without explicit approval.
  - The `main` ruleset requires a PR and the `Gate` check; never push to `main`
    directly.

## Work tracking

Work is tracked in the [KasaKame project](https://github.com/orgs/kasakame/projects/1).
The project README is the source of truth for the hierarchy (Component ->
Epic -> Ticket), the epic lifecycle, the issue-vs-direct-edit rule, priority and
status definitions, the views, and the commands.

- Every ticket belongs to an epic; if no existing epic fits, create one under
  the component. A ticket never sits under another ticket.
- Create issues only for changes that need a PR. Project metadata edits are done
  directly; if one changes the workflow, update the project README.
- Before opening a PR, set the linked issue's type, parent epic, component, and
  priority, and sync the epic status. The PR template repeats this check.
- Use the Epic and Component forms for those issue types; do not create them as
  Task and retype.
- Milestones: use the current release milestone from the project; do not create
  one per package unless a package ships alone. Product design and open questions
  live in [`docs/design.md`](docs/design.md).

## References

Official Algorand docs - consult these (and cite them in `docs/`) instead of
working from memory on protocol details:

- [Applications](https://dev.algorand.co/concepts/smart-contracts/apps/) - app
  lifecycle, `DeleteApplication`, inner transactions.
- [Box Storage](https://dev.algorand.co/concepts/smart-contracts/storage/box/) -
  box MBR, box deletion, app-deletion caveats.
- [Inner Transactions](https://dev.algorand.co/concepts/smart-contracts/inner-txn/) -
  app-account payments and inner-txn fees.
- [Protocol parameters](https://dev.algorand.co/concepts/protocol/protocol-parameters/) -
  program size/pages, opcode budget, app args, box and state limits.
- [Smart contract costs & constraints](https://dev.algorand.co/concepts/smart-contracts/costs-constraints/) -
  MBR formulas, program size, fees.
- [Fees](https://dev.algorand.co/concepts/transactions/fees/) - minimum fee,
  larger-transaction surcharge, fee pooling.
- [AVM](https://dev.algorand.co/concepts/smart-contracts/avm/) - execution model,
  resource availability, stack and program limits.
- [Ledger parameters](https://specs.algorand.co/ledger/ledger-parameters) - exact
  consensus values (`MaxAppTotalProgramLen`, `MaxExtraAppProgramPages`, MBR
  parameters, box limits).
- [Transaction Types](https://dev.algorand.co/concepts/transactions/types/) -
  payment `close`, application call transaction kinds.
- [Indexer REST API](https://dev.algorand.co/reference/rest-api/indexer/) -
  application `deleted` / `deleted-at-round`, `include-all`, box lookup.
- [Algorand TypeScript](https://dev.algorand.co/get-started/algokit/) - AlgoKit and
  `algorand-typescript` entry points.
