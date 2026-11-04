# Contract testing

How the `Campaign` contract is tested: the full offline behavioral matrix plus
LocalNet integration.

## Approach

Two complementary layers:

1. **Offline AVM unit tests** (`algorand-typescript-testing` + Vitest) - the main
   behavioral matrix. Runs in-process, no network, deterministic and fast. This is
   where "every method × every branch" is proven.
2. **LocalNet integration** (`contract.integration.test.ts`) - deploy the compiled
   TEAL to a live algod and exercise the flow end-to-end. Proves the compiled
   bytecode behaves as the unit tests expect.

A third layer - **browser E2E / acceptance tests** - is planned but not yet
implemented; it drives the real UI against LocalNet and is described at the end
of this doc.

> The offline tests are not a substitute for the on-chain run - they're the fast
> feedback loop. Both are required before the contract is considered done.

## Tooling

- `@algorandfoundation/algorand-typescript-testing` - offline AVM emulation + test context.
- `vitest` - test runner.
- `@rollup/plugin-typescript` - applies the `puyaTsTransformer` so `.algo.ts` /
  `.algo.spec.ts` files run with AVM semantics in Node.

Config lives in:

- `vitest.config.mts` - wires `puyaTsTransformer` via the TypeScript plugin.
- `vitest.setup.ts` - registers `addEqualityTesters({ expect })` so `uint64` /
  `bytes` / `Account` values compare against native JS values in `expect(...)`.

Run with `npm run test` (see `package.json`).

Commands:

- `npm run test` - offline AVM unit tests only.
- `npm run test:integration` - LocalNet integration tests (requires
  `algokit localnet start` + `npm run build`).
- `npm run test:all` - both.
- `npm run test:coverage` - offline tests with coverage; fails below the
  configured thresholds (see below).

## Coverage

Coverage uses Vitest's built-in V8 provider (`@vitest/coverage-v8`). It measures
the contract source (`smart_contracts/**/*.algo.ts`) and excludes tests and
generated artifacts.

The **meaningful** metrics are lines, branches, and functions - all gated at
100% in `vitest.config.mts`. Statements are intentionally left un-thresholded:
the `@abimethod` decorator wraps each method signature in a statement V8 never
marks as executed, so statement coverage tops out at ~93% even when every real
line is covered.

Run it with `npm run test:coverage`. The thresholds live in
`vitest.config.mts` and are enforced as a CI gate by the `check-contracts` job
(see [`ci.md`](ci.md)).

## Test file naming (important)

The transformer only processes files whose name ends in `.algo.ts`, `.algo.spec.ts`
or `.algo.test.ts`. The contract (`contract.algo.ts`) is transformed; **the test file
must also be transformed**, so it must be named `contract.algo.spec.ts` (not plain
`.spec.ts`). Otherwise contract creation fails with "Cannot create a contract for
class as it does not extend Contract or BaseContract".

## LocalNet integration notes

- Integration tests live in `campaign/contract.integration.test.ts`,
  `claimsvault/contract.integration.test.ts`, and `factory/contract.integration.test.ts` -
  **plain `.test.ts`** files, so the puya
  transformer skips them (no AVM emulation; they talk to real algod).
- Uses `algorandFixture()` to fund throwaway accounts from the LocalNet dispenser.
- Loads the ARC-56 specs at runtime via `fs.readFileSync` with the generic
  `AppFactory` - avoids statically importing the gitignored `*Client.ts`,
  which would break `tsc --noEmit` in CI (artifacts aren't checked in).
- LocalNet algod runs in **dev mode**: block timestamp = previous tip timestamp +
  offset. `advanceTime(n)` sets the offset, produces any transaction (a self-payment
  "time bump"), then resets the offset in a `finally`.
- Two hand-testing scripts live in `projects/contracts/scripts/localnet/` (LocalNet only,
  run with `npx tsx scripts/localnet/<name>.ts`):
  `fund-account.ts` (`ADDRESS=… [ALGO=…]`, dispenser-funds any empty wallet) and
  `advance-time.ts` (`SECONDS=…`, moves the chain clock past deadlines; the
  offset persists until changed, so new campaigns use it as their baseline).
- Inner transactions need fee pooling via `extraFee: (1000).microAlgo()` per
  inner txn - and each OpUp iteration submits *two* inners (create + delete), so
  `ensureBudget` calls cost double: pledge group (pay + pledge + credit with
  first-touch factory check) → 4000; `cancelPledge`/`refund`/`vault.refund`
  (1 OpUp iteration + payout call) → 4000; `claim` (inner app call + inner
  payment) → 3000; `delete` (settle/notify + escrow close) → 3000;
  `settleOpen` (no inners) → 1000; `finalize` → 2000 with residual, 1000
  without. Amounts are never reduced by fees.
- `pledge(pay,byte[])` reads the vault's app address from state, so the call
  carries no app references; the payment goes to the **vault app account**,
  never the escrow. The three transactions must form ONE group - and the SDK
  composer does not dedupe, so pass the payment either explicitly
  (`addTransaction`) or by method-arg reference, never both.
- `cancelPledge` / `refund(k,amount,txid,path)` / `vault.refund` take the path
  as one blob (`siblings ‖ top ‖ lower`); `delete()` needs the vault box
  declared even for pristine campaigns (settle no-ops without one).
- The vault's one 65-byte campaign box (`'c' + appId`) is declared on every
  outer transaction that triggers inner vault calls; first-touch `credit`
  additionally declares the Factory app plus its registration box
  (`'r' + appId`) for the inner `isRegistered` call. Inner calls to *oneself*
  are forbidden by consensus - budget headroom comes from `ensureBudget`, never
  self-calls. The vault's own methods get their boxes auto-populated from the
  ARC-56 spec.
- The setup chain is: `create(vault, …)` → `register`. There is no funding
   step - the escrow never holds funds.
- Post-settlement refunds call the vault directly:
  `refund(uint64,uint64,uint64,byte[],byte[])void` with the campaign app id -
  the vault verifies the path against its own stored root.
- `delete()` uses the dedicated `send.delete` path (or a manual composer group
  with `DeleteApplicationOC`); `send.call` with an `onComplete` override
  mis-encodes the call.
- Raw inner `appArgs` must ABI-encode dynamic types: the settle `root`
  (`byte[]`) carries its uint16 length prefix - static `uint64`/`address` args
  go raw.
- Do **not** pass `updatable`/`deletable` to `factory.send.create` - the contract TEAL
  has no deploy-time templates for them.

## Integration test inventory

The contract package's LocalNet integration tests (run with
`npm run test:integration` in `projects/contracts`; 21 tests across 3 files).
Each file deploys its own fixture chain to a live algod.
The contract files run **sequentially** (`--no-file-parallelism`): they share one
LocalNet sandbox, and `setBlockOffsetTimestamp` time-travel is chain-global -
parallel files can jump the clock between another file's deploy and pledge,
flaking with `pledging is closed`. Sequential files keep each suite's
chain-relative deadlines (`+600s` at deploy) valid.
Offline specs live next to each contract (`contract.algo.spec.ts`: 44 campaign +
73 vault + 63 factory + 2 deployer + 8 deploy-config tests = 190, all green with
100% line/branch/function coverage).

**Ledger accounting.** The lifecycle integration tests assert the money ledger,
µA-exact, for the actors involved: balance and minimum-balance deltas per
account, the fee totals of each operation (measured on LocalNet - the pledge
group costs 4000 µA, spends and vault refunds 4000 µA, claims 3000 µA), the
vault pool movement, the parked box MBR (32,100 µA per campaign box on the
vault, released by `notifyDelete`/`releaseClaimed`/`finalize`), and the
registration deposit (18,900 µA, returned by `unregister` in the
`[unregister, delete]` group). Rejected transactions are asserted to move
**nothing** (atomic failure charges no fee).

These assertions are relative deltas. The absolute app MBR of each deployed app
is **not** asserted yet, which is how the 2026-11-04 MBR arithmetic error
(321,000 vs the real 571,000) went unnoticed: every test funded its accounts
generously and compared before/after. An absolute per-wallet/per-app
minimum-balance suite is tracked in [#75](https://github.com/kasakame/kasakame/issues/75). The current size/MBR/fee table
is in [`limits.md`](limits.md).

**Contract sizes.** The compiled approval/clear bytes, page count, and app MBR
are **not** asserted by a test yet. The measurement command is in
[`limits.md`](limits.md#measure-the-current-sizes); a size-budget regression test
is tracked in [#76](https://github.com/kasakame/kasakame/issues/76).

**Differential tree assertions.** Pledge/cancel/refund tests drive the Python
reference oracle (`smart_contracts/oracle.py`, backed by
`docs/claim-tree-protocol-reference.py`) with the REAL confirmed payment TxIDs
and assert `root`/`n`/`raised` - plus the vault box's `paidIn`/`paidOut` - after
every step. Forged frontiers, stale proofs, and double-spends are asserted to
reject with state untouched.

### `smart_contracts/campaign/contract.integration.test.ts` (9 tests)

The full claim-tree lifecycle plus the attack matrix, deployed against a real
Factory + ClaimsVault + Campaign.

| # | Test | Verifies |
| --- | --- | --- |
| 1 | embedded selectors match the ARC-56 specs | The four inner-call selectors plus the pledge's `credit` selector appear in the campaign TEAL; the vault embeds the campaign pledge selector; the Factory embeds the campaign delete selector |
| 2 | pledge → cancel → refund lifecycle, differentially verified | Four pledges (one re-pledge) with per-step root/n/raised + `paidIn`; forged-frontier rejection; pre-deadline cancel; non-sequential post-deadline refunds to zero; double-refund rejection |
| 3 | unregistered campaigns cannot touch the vault | First-touch `credit` fails with `campaign not registered`; no box is created |
| 4 | inner-only vault methods reject top-level callers | Direct `payBack`/`payClaim`/`settle`/`notifyDelete` fail with `not the campaign app` - the payout authority is unusable off the campaign path |
| 5 | successful claim pays the creator exactly, then deletes O(1) | Goal reached → creator paid the full live total; box `Claimed`; atomic `[unregister, delete]` returns the deposit, releases the box, and deletes the app |
| 6 | failed campaign settles on delete; vault refunds after deletion; finalize sweeps the residual | `settle` writes root/N/`Failed`; permissionless `vault.refund` pays post-delete; early `finalize` with a residual is rejected; post-window residual goes to the sweep target and the box is gone |
| 7 | pristine and all-cancelled campaigns delete cleanly | Both clean up through the atomic `[unregister, delete]` group; no-box settle no-ops; fully-cancelled delete settles to `Failed` with nothing owed; `finalize` releases the balanced box immediately |
| 8 | settleOpen lets a stranger settle a vanished-creator campaign | Permissionless settle from live globals; the campaign path then rejects (box not open) and the vault path serves refunds |
| 9 | a pledge without the matching vault credit is rejected | `pledge` requires the vault credit immediately next; the group is rejected and n/raised stay 0 |

### `smart_contracts/claimsvault/contract.integration.test.ts` (7 tests)

| # | Test | Verifies |
| --- | --- | --- |
| 10 | first touch creates the box with exact MBR accounting | Box fields on first pledge; pool total rises by exactly the pledge; minimum balance parks exactly 32,100 µA |
| 11 | two campaigns share the pool with per-campaign isolation | Draining campaign A leaves B's box (root, `paidOut` 0) untouched; the pool holds exactly B's live pledge |
| 12 | settleOpen + vault refunds + zero-residual finalize | Stranger settlement; direct refund + double-refund rejection; `finalize` with nothing left deletes the box with no payment even before the window and frees the MBR |
| 13 | a credit without a pledge is rejected (spec §17 #29) | The vault requires the campaign pledge immediately before `credit`; the group is rejected and no box is created |
| 14 | a deleted campaign cannot be pledged, so it cannot be credited | The pristine campaign is deleted through the atomic cleanup group (registration removed); a pledge group to the deleted app fails at the pledge call; no box is created |
| 15 | releaseClaimed recovers a claimed box permissionlessly; delete still works | A stranger deletes the Claimed box and frees its MBR; the creator's later `delete` succeeds because `notifyDelete` is a no-op |
| 16 | one payment cannot back two credits in one group | The first `credit` is not the group's final transaction (and the second has no preceding pledge); the whole group is rejected and no box is created |

### `smart_contracts/factory/contract.integration.test.ts` (6 tests)

| # | Test | Verifies |
| --- | --- | --- |
| 17 | register/isRegistered/unregister round trip with a real Campaign | Registration against the real deployed program hash and the bound official vault; the deposit lands on the Factory and returns in the atomic `[unregister, delete]` group; `isRegistered` reflects the state |
| 18 | an impostor copy of the Campaign contract cannot register | The program-hash check rejects a non-official program |
| 19 | a campaign bound to a different vault cannot register | The Factory's vault binding rejects a campaign whose `vault` global differs |
| 20 | a non-creator cannot register someone else's campaign, and registration is refused before the hash is configured | Creator gating; unconfigured-hash refusal |
| 21 | only the owner can set the official hash, and only the registered creator can unregister | Factory ownership, deposit protection, and the required delete pairing |
| 22 | an unregistered campaign cleans up through the same group | `unregister` no-ops for an unregistered campaign, the campaign requires the preceding unregister, and the delete removes the app |

## SDK LocalNet integration

`projects/sdk/src/transactions.integration.test.ts` closes the client send-path
gap: it deploys a Factory + ClaimsVault from the ARC-56 bytecode embedded in the
generated clients, calls `configureSdk`, and drives the SDK write helpers against
a live chain. Three flows run with fresh campaigns and generated-account signers:

1. **create → pledge → cancel → delete** - the open-campaign lifecycle, including
   the `[pay, campaign.pledge, vault.credit]` group and the backer's withdrawal.
2. **successful campaign → claim → delete** - the creator payout and the atomic
   `[unregister, delete]` cleanup.
3. **failed campaign → refund before delete → delete → refund after delete** -
   the campaign refund path, then the vault refund path once the app is gone.

Deadlines are chain-relative and fast-forwarded with the dev-mode block offset;
the offset is reset in a `finally`, and the suite runs with
`--no-file-parallelism` because the offset is chain-global. It is excluded from
`npm test` and coverage.

Run it with LocalNet up:

```bash
cd projects/sdk
npm run test:integration
```

The suite uses the clients currently in `src/generated`, so it tests the pinned
specs release by default. To exercise the local contracts instead, build them and
regenerate against the local artifacts first:

```bash
cd projects/contracts && npm run build
cd ../sdk && SDK_SPECS=local npm run codegen
npm run test:integration
```

The setup adapts to both shapes: the 2026-11 Factory binds the vault, pins the
vault program hash, and hashes `itob(approval length) ‖ approval ‖ clear`, while
the pinned release predates all three.

## API cheat sheet (learned the hard way)

- `const ctx = new TestExecutionContext()`; **create the context once per suite and
  call `ctx.reset()` in `beforeEach`** - constructing a second context throws
  ("Execution context has already been set").
- `ctx.contract.create(Campaign)` returns a proxied instance.
- `Campaign extends Contract` (ARC4), so `@abimethod` methods auto-assemble an app-call
  transaction group when called directly:
  - `contract.create(vault, title, uri, goal, deadline)` works - the `onCreate: 'require'` guard is
    enforced via the runtime's `isCreating` flag, not a real app-id check.
  - `contract.pledge(payment, frontier)` takes a `ctx.any.txn.payment({ sender, receiver, amount })`
    (its `txnId` is readable for oracle-differential assertions); the frontier is plain bytes.
- `Txn.sender` defaults to `ctx.defaultSender`. To act as a different account, wrap the
  call:

  ```ts
  ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: other })]).execute(() => {
    contract.claim()
  })
  ```

- `Global.latestTimestamp` defaults to `Date.now()` (ms) per group - **patch it
  explicitly** before `create`/settlement tests:
  `ctx.ledger.patchGlobalData({ latestTimestamp: 1000 })`. Remember the `create` guard
  is `deadline > latestTimestamp` (strict), so pin the creation time and use a larger
  deadline.
- App escrow address: `ctx.ledger.getApplicationForContract(contract).address`.
- Inner app calls to stub apps succeed as no-ops, but their logs are NOT emulated:
  gate the call on `lastLog` only on LocalNet, and `v8 ignore` the gate offline
  (see `checkRegistration`).
- Inner-call targets must be `Application`-typed state (not bare `uint64` ids) -
  the offline emulator only resolves those.
- Inner payments (from `claim`/`refund`/`cancelPledge`/`delete`/`finalize`): assert via
  `ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()`; inner app calls via
  `getApplicationCallInnerTxn()` (its `appArgs(0)` carries the method selector -
  assert it to keep the embedded selectors in sync).
- `ensureBudget` OpUp loops run offline (each iteration submits two inners); size
  `extraFee` accordingly on LocalNet (measured table in
  [`campaign.md`](campaign.md)).
- Failure assertions: `assert` throws `AssertError` with the message, so
  `expect(() => ...).toThrowError('...')` works verbatim.
- `vitest.config.mts` must override `compilerOptions.module: 'esnext'` (the contract
  tsconfig is CommonJS); otherwise the transformer-injected `runtime-helpers` import
  fails against the package's ESM-only exports map.
- `package.json` test script uses `--no-color` to keep AlgoKit's command output clean.
- PuyaTs arithmetic: `+ - *` and comparisons are overloaded for `uint64`, but
  `/ % >> << ^ & |` fall back to JS `number` semantics - use `op.shr`/`op.shl`
  and annotate every derived numeric local, or compilation fails with
  "`number` is not valid".

## Coverage matrix (every method × every branch)

| Method | Branch | Covered? |
| --- | --- | --- |
| `create` | success / zero vault / empty title / overlong title+uri / `goal == 0` / past deadline | ✅ |
| `pledge` | success incl. re-pledge / closed / not open / wrong receiver / wrong sender / zero / close-remainder and rekey payments rejected / creator self-pledge / bad frontier length / forged + stale frontier / mismatched credit (unit) / missing credit (LocalNet) / ClearState credit rejected | ✅ |
| `claim` | success with inner `payClaim` (LocalNet) / non-creator / before deadline / `raised < goal` / double claim | ✅ |
| `refund` | success / before deadline / `raised >= goal` / claimed / bad txid / unknown position / bad path / proof mismatch / double refund (LocalNet) | ✅ |
| `cancelPledge` | success / after deadline / not open / zero amount / bad txid / unknown position / bad path / double cancel (LocalNet) | ✅ |
| `delete` | failed-in-fact materialization + vault settle / claimed + notifyDelete / pristine (settle no-op) / all-cancelled settle / non-creator / live pledges / factory-bound requires the preceding NoOp unregister / raw and ClearState delete bypass rejected | ✅ |
| `ClaimsVault.create` | success / zero window / window above the 10-year cap / zero factory / zero sweep target / vault itself as sweep target | ✅ |
| `credit` | preceding pledge required / wrong pledge app/sender/args/selector / ClearState pledge rejected / existing-box inflow / zero amount / unregistered first touch / closed box / no matching payment / close-remainder and rekey payments rejected | ✅ (+ first-touch happy path on LocalNet) |
| `payBack` | success / non-campaign caller / unknown campaign / closed box / zero / insufficient | ✅ |
| `payClaim` | success (derived amount) / non-campaign caller / unknown / closed box / empty payout | ✅ |
| `settle` | success / already failed (no-op) / missing box (no-op) / claimed / non-campaign caller / bad root | ✅ |
| `settleOpen` | success from live globals / unknown / closed box / claimed campaign / early deadline / reached goal / malformed root / campaign bound to another vault | ✅ |
| `vault.refund` | success differentially (LocalNet) / unknown / not failed / window closed / unknown position / bad txid+path / proof mismatch / insufficient | ✅ |
| `notifyDelete` | success / missing box (no-op) / non-campaign caller / not claimed / unbalanced | ✅ |
| `finalize` | residual sweep + box delete / zero-residual delete before or after the window / unknown / not failed / window open with residual (all LocalNet) | ✅ |
| `Factory.setApprovalHash` | success / non-owner / wrong length / second direct set rejected (timelock bypass) | ✅ |
| `Factory.proposeApprovalHash` / `applyApprovalHash` / `cancelApprovalHash` | propose stores pending + eligibility / non-owner / wrong length / apply before timelock / no pending / non-owner / apply after timelock / cancel clears / non-owner | ✅ |
| `Factory.setVaultApprovalHash` | success / non-owner / wrong length / change after vault bound | ✅ |
| `Factory.setVault` | success / non-owner / already set / vault bound to another Factory / no factory binding / vault hash not configured / lookalike vault program | ✅ |
| `Factory.transferOwnership` / `renounceOwnership` | transfer / new owner can configure / old owner rejected / non-owner / zero address / renounce locks configuration / non-owner renounce | ✅ |
| `Factory.register` | success / unconfigured program hash / unconfigured vault / wrong vault / custom clear-state program / different approval/clear split / non-creator / impostor / low deposit / wrong payer / wrong receiver / close-remainder and rekey payments rejected / double registration | ✅ |
| `Factory.unregister` | success (pristine / all-cancelled / failed / claimed / failed-in-fact) / unregistered no-op / live rejection / missing state / non-creator / delete pairing (missing / wrong app / sender / action / args / selector) | ✅ |
| Attacks (LocalNet) | double-spend / stale + forged proofs / unregistered credit / uncredited pledge / no unpaired credit / atomic delist+delete / top-level inner-only calls / settleOpen interplay / window enforcement / self-harm containment (§17 #29) / pooled isolation | ✅ |

## Browser E2E / acceptance tests

**Status: planned, not yet implemented.**

This layer drives the real UI in a browser against a running LocalNet, clicking
buttons and checking observable results the way a user would: connect a wallet,
browse, create a campaign, pledge, cancel a pledge, claim, and refund. It
complements the two layers above rather than replacing them.

### Why it's needed

The existing layers share one blind spot: they do not exercise the **SDK
send path** (`projects/sdk/src/transactions.ts`) against a live chain. The contract
integration tests call the low-level client directly (with `extraFee`), so a bug
in the frontend helpers (for example, `coverAppCallInnerTransactionFees: true`,
which throws at send time because the typed client doesn't populate the required
`maxFee` context) passes unit tests and integration tests, and fails only when a
real user clicks a button. Browser E2E tests close this gap.

### Scope

- **Connect wallet** - via a test signer standing in for Pera/Defly (see below),
  not a real wallet popup.
- **Browse** - campaign list renders seeded campaigns.
- **Create** - fill the form, submit, assert the new campaign appears.
- **Pledge** - enter an amount, submit, assert `raised` and "Your pledge" update.
- **Cancel pledge** - assert the button appears only while `open` with a pledge,
  and that clicking it returns the pledge (raised drops back, the leaf is gone).
- **Claim / refund** - after fast-forwarding the deadline, assert the creator /
  backer flows complete.

### Wallet strategy

Automating real Pera/Defly wallet popups is brittle and out of scope for a
first cut. The plan is to inject a **test signer** (a LocalNet-funded mnemonic)
so the app signs transactions without a real wallet. This reuses the existing
`WalletSession` shape (`{ address, signer }`) in the SDK
(`projects/sdk/src/transactions.ts`). The
remaining questions to settle before implementing:

- Whether to run against the `npm run dev:localnet` Vite server or a `vite build` preview
  (preview is closer to prod, dev is faster to iterate).
- Playwright vs. Vitest browser mode (Playwright is the natural fit for
  click-driven flows; Vitest browser mode keeps it in the existing runner).
- How to seed campaigns idempotently before each run (`npm run seed:localnet` / `npm run unseed:localnet`
  in `projects/contracts`, state-tracked via `scripts/.seed-state.<network>.json`; the `:testnet` variants read
  `.env.testnet` instead) and reclaim afterwards (`npm run reclaim` in `projects/frontend`, which reads
  its `.env.testnet`: refunds/cancels known leaves, deletes, unregisters; unknown leaves reported).

### Where it lives

TBD once the tooling is chosen, but expected under `projects/frontend/e2e/` (or a
new top-level `e2e/`), with its own script wired into `package.json`. CI wiring
comes later - see [`ci.md`](ci.md).

## CLI tests

The CLI has its own Vitest suite in `projects/cli/src/*.spec.ts`. It mocks the
SDK and the WalletConnect transport, so it runs offline and never contacts the
bridge. Coverage is gated at 100% across lines, branches, functions, and
statements.

The suite drives the command layer: argument validation, read tables, refund
and withdraw selection and partial failure, the creator checks for claim and
delete, dry runs, the wallet session lifecycle and signer handshake, mnemonic
validation for both 25-word Algo25 and 24-word ARC-52 phrases, and the bridge
and storage fallbacks. The `check-cli` job in CI runs format, lint, type-check,
coverage, and the build (see [`ci.md`](ci.md#workflow-build-and-test)); the
release workflow packs the tarball and runs `kasakame --help` before publishing
(see [`ci.md`](ci.md#workflow-release-cli-separate-file)).

Manual TestNet smoke remains in the [manual smoke ticket](https://github.com/kasakame/kasakame/issues/126):
both signers, refund before and after a delete, and delete on a fresh campaign.
The CLI behavior is documented in [`cli.md`](cli.md).
