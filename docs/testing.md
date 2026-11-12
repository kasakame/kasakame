# Contract testing

How the `Campaign` contract is tested: the full offline behavioral matrix plus
LocalNet integration.

## Approach

Two complementary layers:

1. **Offline AVM unit tests** (`algorand-typescript-testing` + Vitest) - the main
   behavioral matrix. Runs in-process, no network, deterministic and fast. This is
   where "every method × every branch" is proven.
2. **LocalNet integration** (`integration/*.test.ts`) - deploy the compiled
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
- `npm run test:integration` - LocalNet integration tests, files `00`-`04` (requires
  `algokit localnet start` + `npm run build`).
- `npm run test:integration:heavy` - LocalNet heavy lane, files `05`-`07`.
- `npm run test:integration:all` - both LocalNet lanes.
- `npm run test:size` - contract size budget (requires `npm run build`).
- `npm run test:all` - every contract suite, including LocalNet integration and the
  size budget (requires `algokit localnet start` and `npm run build`).
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

## Suite map

| Suite | File pattern | Command | CI job | Trigger |
| --- | --- | --- | --- | --- |
| Offline AVM unit | `**/*.algo.spec.ts`, `deployer.spec.ts`, `deploy-config.spec.ts`, `smart_contracts/testing/localnet.spec.ts` | `npm run test` / `npm run test:coverage` | Check contracts | `pull_request`, push to `main`, manual |
| Contract size budget | `size-budget.spec.ts` | `npm run test:size` | Compile contracts (after `npm run build`) | same as above |
| Contract LocalNet, normal lane | `integration/*.test.ts` | `npm run test:integration` | LocalNet integration | `pull_request` / push to `main` when contracts change, manual |
| Contract LocalNet, heavy lane | `integration/05-*.test.ts`, `integration/06-*.test.ts`, `integration/07-*.test.ts` | `npm run test:integration:heavy` | separate scheduled job (#122), not required for PRs | weekly `schedule` + `workflow_dispatch` |
| SDK LocalNet | `src/*.integration.test.ts` | `npm run test:integration` in `projects/sdk` | manual today (#158) | LocalNet running |
| CLI LocalNet smoke (planned, #118) | `projects/cli` | tracked in #118 | not wired yet | - |

The normal lane uses small shapes (4-5 backers, about 10 campaigns) and one
seeded sequence. The heavy lane raises N, campaigns/backers, and seed count through
the same config, without changing the test code. Counts, N, and seeds are helper
parameters, not constants inside the suites. The shared cross-project harness is #164.

## Integration test order

The contract integration tests are numbered files. The number is the order;
tests inside keep their own IDs. Files `00`-`04` are the normal lane, `05`-`07` are the
heavy lane.

| File | Tests | Tags | What it proves |
| --- | --- | --- | --- |
| `integration/00-deploy.test.ts` | `CON-001`..`CON-006` | `smoke`, `always` | Factory + Vault deploy, hashes, vault binding, app accounts, selectors; hash timelock propose/apply/cancel, ownership transfer/renounce, setVault lookalike/wrong-program/already-set guards |
| `integration/01-single-campaign.test.ts` | `CON-010`..`CON-015` | `smoke`, `happy`, `always`/`chain` | create one campaign, pledge, cancel, delete; pristine delete (registered and unregistered); one full solo workflow; registration round trip |
| `integration/02-funding.test.ts` | `CON-020`..`CON-025`, `CON-030`..`CON-033`, `CON-040`..`CON-044` | `happy`, `always`/`chain` | failed refund path, successful claim path, early-finalize rejection, residual sweep, standalone workflows, `settleOpen`, `releaseClaimed` |
| `integration/03-multi-actor.test.ts` | `CON-050`..`CON-055`, `CON-060`/`CON-061`, `CON-062` | `happy`, `scale`, `always`/`chain` | 10 campaigns/10 creators, five backers, creator-as-backer, isolation, vault pool accounting, one seeded normal-lane sequence |
| `integration/04-bad-paths.test.ts` | `CON-100`..`CON-127` | `bad`, `always` | pledge and credit guards (close/rekey, ClearState, wrong app/args/onCompletion), stale and forged proofs with retry, vault refund and `settleOpen`/`releaseClaimed` matrices, deleted-campaign spends, Factory register deposit/group guards |
| `integration/05-scale.test.ts` | `CON-202` | `scale`, `always` | 25 campaigns by 25 creators with 4 backers each; campaign isolation under load |
| `integration/06-tree-boundaries.test.ts` | `CON-200`/`CON-201`, `CON-210`..`CON-221` | `scale`, `always`/`chain` | N=16/100 boundaries plus the cumulative 15→1,024 ladder; settlement, campaign refund, vault refund, and finalize at 1,024 |
| `integration/07-sequences.test.ts` | `CON-230` | `scale`, `happy`, `always` | three heavy seeds; random pledge/cancel/refund/finalize sequences with oracle assertions |

- `beforeAll` deploys only the platform and wallets; campaigns are created by the tests.
- `always` tests run alone with `vitest -t <ID>` and after unrelated failures.
- `chain` tests share campaign A and skip the rest of the chain after the first failure.
- The `06` ladder grows one campaign through N=15..1,024; run it in order (only `CON-210` creates the campaign).
- `07` runs three heavy seeds; `CON-062` runs one normal-lane seed through the same engine.
- The legacy `smart_contracts/**/contract.integration.test.ts` files are retired; their coverage lives in these files (see [Legacy migration map](#legacy-migration-map)).

### Scale config and seeds

`integration/support/scale.ts` holds the typed `ScaleConfig`. `03`/`05` use the
normal/heavy presets and `07` runs the heavy seeds through the same
`integration/support/sequence.ts` engine. Every field has an env override:
`KASAKAME_CREATORS`, `KASAKAME_CAMPAIGNS`, `KASAKAME_BACKERS`,
`KASAKAME_PLEDGES_PER_BACKER`, `KASAKAME_MAX_N`, `KASAKAME_SEED`, and
`KASAKAME_SEED_COUNT`. The active config and seed are printed on failure.

### Budget and cap regressions

`06` pins the exact OpUp take count at every ladder boundary (`LADDER_TAKES`); a
contract budget change that requests one more take fails the step. The offline
cap tests use the `oracle.py bulk` synthetic tree: N=524,286 accepts the last
append, N=524,287 rejects the next, and the refund path asserts 14 takes + 2
payouts = 16 inners. The offline emulator does not enforce the 700-op base
budget, so that count is asserted from the path shape; the LocalNet ladder
exercises the real takes.

```bash
cd projects/contracts
npx vitest run integration/00-deploy.test.ts integration/01-single-campaign.test.ts
npx vitest run integration/01-single-campaign.test.ts -t "CON-014"
npx vitest run integration/02-funding.test.ts -t "CON-040"
npx vitest run integration/03-multi-actor.test.ts -t "CON-060"
npx vitest run integration/04-bad-paths.test.ts -t "CON-100"
npx vitest run integration --tags-filter="smoke"
npm run test:integration
npm run test:integration:heavy
```

## Shared LocalNet helpers

The contract suites import their fixture, oracle, ledger, box, and fee helpers from
`smart_contracts/testing/localnet.ts` through the `integration/support/localnet.ts`
re-export. The helper stays under `smart_contracts/testing/` until the
cross-project harness (#164) moves it; the helper unit spec runs with `npm test`,
while `integration/**` is reserved for LocalNet tests:

- `deployStack` deploys and funds the Factory, deploys and binds the vault, and
  optionally configures the campaign hash. `deployCampaign`, `registerCampaign`,
  and `deleteCampaign` assert the create/register/cleanup fees and MBRs.
- `pledge`, `spendCampaign`, `spendVault`, and `claimCampaign` send the real
  groups, assert the exact balance/MBR/fee delta for the actor and the vault, and
  compare campaign state and the vault box with the Python oracle.
- `ClaimTreeOracle` wraps `oracle.py` with one state file per campaign.
  `pledgeExtraFee`, `spendExtraFee`, and `spendFee` mirror the contract/SDK take
  formulas.
- `campaignBox`, `campaignBoxExists`, `vaultBoxRef`, `registrationBoxRef`,
  `accountInfo`, `balanceOf`, `minBalanceOf`, `advanceTime`, `concatHex`,
  `base32ToBytes`, and `addrHex` are the shared primitives.

`smart_contracts/testing/localnet.spec.ts` pins the fee formulas and the embedded selectors
offline, so a contract or SDK formula change fails without LocalNet.

## Test file naming (important)

The transformer only processes files whose name ends in `.algo.ts`, `.algo.spec.ts`
or `.algo.test.ts`. The contract (`contract.algo.ts`) is transformed; **the test file
must also be transformed**, so it must be named `contract.algo.spec.ts` (not plain
`.spec.ts`). Otherwise contract creation fails with "Cannot create a contract for
class as it does not extend Contract or BaseContract".

## Contract size budget

`npm run test:size` reads the built ARC-56 bytecode and asserts the pinned
approval/clear/total bytes, extra pages, page capacity, global schema, and app
MBR in `smart_contracts/size-budget.fixture.ts`. It runs in the
`compile-contracts` CI job after `npm run build`; update the fixture and
[`limits.md`](limits.md) together when a contract changes. It is excluded from
`npm test` and `test:coverage` because those jobs do not build the artifacts.

## LocalNet integration notes

- Integration tests live in `integration/*.test.ts` (files `00`-`07`) -
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
  inner txn. Each OpUp iteration submits **one** inner app call (the Puya
  create-and-delete program), so `ensureBudget` costs 1000 µA per take and adds
  700 ops. The SDK computes the take count from the tree; localnet tests should
  use the same `pledgeExtraFee`/`spendExtraFee` helpers (or a generous headroom)
  rather than fixed 4000 µA. Base groups: pledge (pay + pledge + credit with
  first-touch factory check) → 4000; `cancelPledge`/`refund`/`vault.refund`
  (outer + inner `payBack` + inner payment, plus takes) → from 3000;
  `claim` (inner app call + inner payment) → 3000; `delete` (settle/notify +
  escrow close) → 3000; `settleOpen` (no inners) → 1000; `finalize` → 2000 with
  residual, 1000 without. Amounts are never reduced by fees.
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
`npm run test:integration` in `projects/contracts`; 64 normal-lane tests across 5 files
plus 16 heavy-lane tests across `05`/`06`/`07`, 80 total).
Each file deploys its own fixture chain to a live algod.
The contract files run **sequentially** (`--no-file-parallelism`): they share one
LocalNet sandbox, and `setBlockOffsetTimestamp` time-travel is chain-global -
parallel files can jump the clock between another file's deploy and pledge,
flaking with `pledging is closed`. Sequential files keep each suite's
chain-relative deadlines (`+600s` at deploy) valid.
Offline specs live next to each contract (`contract.algo.spec.ts`: 51 campaign +
74 vault + 63 factory + 3 deployer + 8 deploy-config tests = 199) plus 3 helper
formula/selector tests in `smart_contracts/testing/localnet.spec.ts` (202 total), all
green with 100% line/branch/function coverage of the contracts.

**Ledger accounting.** The lifecycle helpers assert the money ledger, µA-exact,
for the actors involved: absolute balance and minimum-balance checks at each
boundary (creator app MBR and deposit, Factory and Vault deployer app MBRs, app
account bases, box MBRs), the fee totals of each operation (measured on LocalNet -
the pledge group costs 4000 µA at small trees, campaign spends start at 4000 µA,
vault refunds at 3000 µA, and claims 3000 µA; each OpUp take adds 1000 µA; the
spend helper funds one extra take as headroom, so its asserts start at 5000 µA
for campaign spends and 4000 µA for vault refunds), the
vault pool movement, the parked box MBR (32,100 µA per campaign box
on the vault, released by `notifyDelete`/`releaseClaimed`/`finalize`), and the
registration deposit (18,900 µA, returned by `unregister` in the
`[unregister, delete]` group). Rejected transactions are asserted to move
**nothing** (atomic failure charges no fee). The expected app MBRs come from
`size-budget.fixture.ts`, so a schema or page change fails until the fixture and
`docs/limits.md` are updated.

**Contract sizes.** `npm run test:size` reads the built ARC-56 bytecode and pins
the approval/clear bytes, page count, schema, and app MBR in
`smart_contracts/size-budget.fixture.ts`; it runs in the `compile-contracts` CI
job after `npm run build`. See [`limits.md`](limits.md) for the current values.

**Differential tree assertions.** Pledge/cancel/refund tests drive the Python
reference oracle (`smart_contracts/oracle.py`, backed by
`docs/claim-tree-protocol-reference.py`) with the REAL confirmed payment TxIDs
and assert `root`/`n`/`raised` - plus the vault box's `paidIn`/`paidOut` - after
every step. Forged frontiers, stale proofs, and double-spends are asserted to
reject with state untouched.

### Test inventory

Every integration test carries a stable `CON-<NNN>` ID in its title. `Class` is
`always` (independent; runs alone with `vitest -t <ID>`) or `chain` (depends on
earlier tests in the same file, which stop on first failure).

#### `integration/00-deploy.test.ts` (6 tests)

| ID | Test | Class | Verifies |
| --- | --- | --- | --- |
| `CON-001` | Factory is owned and bound to the official vault | always | Owner, bound vault, campaign hash equals the compiled bytecode, Factory app-account funding, owner MBR |
| `CON-002` | ClaimsVault records the Factory, sweep target, and window | always | Vault globals (factory, sweep target, refund window) and app-account funding |
| `CON-003` | contracts embed the expected inner-call selectors | always | Campaign/Vault/Factory TEAL embeds the selectors used by the inner calls |
| `CON-004` | Factory hash timelock: propose, reject early apply, cancel | always | Owner-only propose, eligible round = propose round + `APPROVAL_HASH_DELAY`, early apply rejected, cancel clears the proposal, apply with no pending rejected |
| `CON-005` | Factory ownership transfer and renounce | always | Non-owner rejected, zero address rejected, transfer gives control to the new owner, old owner loses it, renounce leaves nobody able to configure |
| `CON-006` | Factory setVault guards: wrong factory, wrong program, already set | always | Foreign vault, wrong program hash, non-owner, and already-bound rejection; the binding stays unset on failure |

#### `integration/01-single-campaign.test.ts` (6 tests)

| ID | Test | Class | Verifies |
| --- | --- | --- | --- |
| `CON-010` | create campaign A | chain | Campaign create, `n=0`, `raised=0`, no vault box yet, `isRegistered` true |
| `CON-011` | pledge to campaign A | chain | `[pay, pledge, credit]` group; `n=1`, `raised=2 ALGO`, vault box created |
| `CON-012` | cancel the pledge | chain | `cancelPledge` nulls the leaf, `raised=0`, exact payback through the vault |
| `CON-013` | delete the cancelled campaign | chain | App deleted, campaign box retained for `finalize`, `isRegistered` false (unregister round trip) |
| `CON-014` | delete a pristine campaign, registered and unregistered | always | Both cleanup paths: registered returns the deposit; unregistered `unregister` is a no-op; app gone |
| `CON-015` | single-test happy path: create, pledge, cancel, delete | always | One standalone end-to-end lifecycle with ledger assertions |

#### `integration/02-funding.test.ts` (15 tests)

| ID | Test | Class | Verifies |
| --- | --- | --- | --- |
| `CON-020` | create campaign F | chain | Failed-path campaign create and ledger |
| `CON-021` | three backers pledge below the goal | chain | Three distinct leaves, box `paidIn`, `n`, `raised` |
| `CON-022` | advance and refund one backer through the campaign | chain | Post-deadline campaign refund flips the status to Failed once and pays the backer |
| `CON-023` | delete the failed campaign | chain | `delete` settles the vault box with the final root/N/`settledAt` |
| `CON-024` | refund another backer through the vault after delete | chain | Vault refund works after the app is gone; double refund rejected |
| `CON-025` | reject early finalize, then sweep the residual | chain | `finalize` rejects while funds remain; after the window the residual goes to the sweep target and the box is gone |
| `CON-030` | create campaign S with a 3 ALGO goal | chain | Successful-path campaign create |
| `CON-031` | fund the campaign to its goal | chain | Goal reached, one leaf, box totals |
| `CON-032` | advance and claim | chain | Creator paid exactly, box Claimed, `paidIn == paidOut` |
| `CON-033` | delete the claimed campaign and release its box | chain | Atomic `[unregister, delete]`, deposit returned, box MBR released |
| `CON-040` | standalone failed campaign workflow | always | Create → pledge → deadline → campaign refund → delete → vault refund |
| `CON-041` | standalone successful claim workflow | always | Create → pledge → claim → delete with no other test state |
| `CON-042` | `settleOpen`, vault refund, and zero-residual finalize | always | Stranger settles a vanished-creator campaign, backer refunds from the vault, `finalize` frees the empty box |
| `CON-043` | `settleOpen` makes the campaign refund path reject | always | After permissionless settlement the campaign path rejects; the backer balance is unchanged |
| `CON-044` | `releaseClaimed` recovers a claimed box permissionlessly | always | Stranger releases a fully-paid Claimed box and its MBR; the creator's later `delete` still works |

#### `integration/03-multi-actor.test.ts` (9 tests)

| ID | Test | Class | Verifies |
| --- | --- | --- | --- |
| `CON-050` | create 10 campaigns by 10 creators (config-driven) | chain | Many creators and campaigns share the Factory/Vault |
| `CON-051` | 5 backers pledge to campaign 0 (config-driven) | chain | Multiple distinct leaves on one campaign |
| `CON-052` | one backer pledges to several campaigns | chain | The same account can hold leaves in different campaigns |
| `CON-053` | a creator backs another campaign | chain | Creator-as-backer is allowed on someone else's campaign |
| `CON-054` | drain campaign 0 without touching the others | chain | Cancels/refunds are isolated per campaign |
| `CON-055` | vault pool holds only the live pledges | chain | Pool balance equals the sum of live `paidIn - paidOut` |
| `CON-060` | creators can back each other | always | Two creators pledge to each other's campaigns |
| `CON-061` | refunding one campaign leaves the other untouched | always | Per-campaign accounting isolation |
| `CON-062` | seeded pledge/cancel/refund/finalize sequence | always | One normal-lane seed through the shared sequence engine (N ≤ 100) |

#### `integration/04-bad-paths.test.ts` (28 tests)

| ID | Test | Class | Verifies |
| --- | --- | --- | --- |
| `CON-100` | creator cannot pledge to their own campaign | always | Self-pledge rejected, no state change |
| `CON-101` | pledge payment must go to the vault | always | Wrong receiver rejected |
| `CON-102` | pledge payment sender must be the caller | always | Payment sender mismatch rejected |
| `CON-103` | zero pledge is rejected | always | `amount > 0` guard |
| `CON-104` | pledge below the minimum is rejected | always | 100,000 µA dust guard |
| `CON-105` | stale frontier after a real pledge is rejected | always | Frontier must fold to the stored root |
| `CON-106` | pledge without the matching credit is rejected | always | The credit must immediately follow the pledge |
| `CON-107` | unregistered campaign cannot be credited | always | First touch requires Factory registration; no box created |
| `CON-108` | cancel after the deadline is rejected | always | `cancelPledge` before the deadline |
| `CON-109` | refund before the deadline is rejected | always | Campaign refund after the deadline |
| `CON-110` | refund after the goal was reached is rejected | always | Failed-only refund guard |
| `CON-111` | only the creator can claim | always | Claim authorization |
| `CON-112` | raw delete is rejected | always | `delete` requires the preceding Factory `unregister` |
| `CON-113` | a live campaign cannot be unregistered | always | Live-campaign guard, plus non-creator `unregister` rejection |
| `CON-114` | credit without a preceding pledge is rejected | always | Vault credit group-shape guard |
| `CON-115` | top-level vault inner methods are rejected | always | Direct `payBack`/`payClaim`/`settle`/`notifyDelete` fail with `not the campaign app` |
| `CON-116` | only the Factory owner can set the program hash | always | Owner authorization |
| `CON-117` | program hash must be 32 bytes | always | Hash length guard |
| `CON-118` | an impostor campaign cannot register | always | Program-hash admission rule |
| `CON-119` | vault refund rejects an open box, a claimed box, a closed window, and an unknown position | always | Four refund guards; state and box unchanged |
| `CON-120` | `settleOpen` rejects before the deadline, after the goal, on a claimed box, and on a failed box | always | Four settlement guards |
| `CON-121` | `releaseClaimed` rejects a non-claimed box | always | Claimed-only guard |
| `CON-122` | pledge payment cannot close or rekey | always | Closing/rekeying payments rejected (fee-payer group) |
| `CON-123` | credit guards reject ClearState, wrong amount/app/selector, non-final, and repeated credits | always | Six credit shape guards, including one payment backing two credits |
| `CON-124` | a deleted campaign cannot be pledged or credited | always | `pledge` to a deleted app fails; no box is created |
| `CON-125` | double spends and stale proofs are rejected | always | Stale and forged proofs, same-group double spend, atomic rollback, then a successful retry |
| `CON-126` | Factory register rejects non-creators, different vaults, and double registration | always | Three register guards |
| `CON-127` | Factory register deposit and group guards | always | Deposit amount, receiver/sender, final position, rekey, unconfigured hash; no ledger or state change |

#### `integration/05-scale.test.ts` (1 test)

| ID | Test | Class | Verifies |
| --- | --- | --- | --- |
| `CON-202` | 25 campaigns by 25 creators with 4 backers each (config-driven) | always | Heavy-lane isolation and pool accounting under load |

#### `integration/06-tree-boundaries.test.ts` (14 tests)

| ID | Test | Class | Verifies |
| --- | --- | --- | --- |
| `CON-200` | N=16 crosses the first OpUp take and refunds leaf 0 | always | First budget-take boundary; refund path root/box/ledger |
| `CON-201` | N=100 refunds the worst-case and an interior leaf | always | Deep-path refund and an interior leaf at N=100 |
| `CON-210`..`CON-221` | cumulative ladder at N=15,16,31,32,63,64,100,127,128,255,1,000,1,024 | chain | Each boundary pledges up to N and cancels one leaf with its pinned take count; at N=1,024 it also settles, refunds through the campaign, deletes, refunds through the vault, and finalizes |

#### `integration/07-sequences.test.ts` (1 test)

| ID | Test | Class | Verifies |
| --- | --- | --- | --- |
| `CON-230` | seeded pledge/cancel/refund/finalize sequences | always | Three heavy seeds of random actions with oracle assertions; seed and ordered actions printed on failure |

### Legacy migration map

`#189` moved the legacy-only coverage into the numbered suite, and `#188` deleted
the three legacy files. This map records where each legacy test's coverage now lives:

| Legacy test | New-suite equivalent |
| --- | --- |
| campaign 1: embedded selectors and pinned creator totals | `00` `CON-003`; the lifecycle helpers assert the pinned fee/MBR totals |
| campaign 2: pledge → cancel → refund lifecycle | `01` `CON-010`..`CON-012`, `02` `CON-020`..`CON-024`, `04` `CON-105`/`CON-125` |
| campaign 3: unregistered campaigns cannot touch the vault | `04` `CON-107` |
| campaign 4: inner-only vault methods reject top-level callers | `04` `CON-115` (`payBack`, `payClaim`, `settle`, `notifyDelete`) |
| campaign 5: successful claim pays the creator, then deletes | `02` `CON-030`..`CON-033`, `CON-041` |
| campaign 6: failed campaign settles on delete; refunds after deletion; finalize | `02` `CON-020`..`CON-025`, `CON-040` |
| campaign 7: pristine and all-cancelled cleanup | `01` `CON-013`/`CON-014` |
| campaign 8: `settleOpen` by a stranger | `02` `CON-042`, `04` `CON-120` |
| campaign 9: pledge without the matching credit | `04` `CON-106` |
| campaign 10: funding past N=15 and a wide refund | `06` `CON-200`/`CON-201` and the N=15..1,024 ladder |
| vault 11: first-touch box MBR | every `pledge`/`spendVault` helper ledger assert; `02` `CON-021`/`CON-031` |
| vault 12: two campaigns share the pool with isolation | `03` `CON-055`/`CON-061` |
| vault 13: `settleOpen` + vault refunds + zero-residual finalize | `02` `CON-042` |
| vault 14: credit without a pledge | `04` `CON-114` |
| vault 15: a deleted campaign cannot be pledged or credited | `04` `CON-124` |
| vault 16: `releaseClaimed` and delete still works | `02` `CON-044`, `04` `CON-121` |
| vault 17: one payment cannot back two credits | `04` `CON-123` |
| factory 18: register/isRegistered/unregister round trip | `01` `CON-010` + `CON-013`; the register/delete helpers assert the deposit ledger |
| factory 19: impostor program cannot register | `04` `CON-118` |
| factory 20: campaign bound to a different vault cannot register | `04` `CON-126`; `00` `CON-006` covers the Factory side |
| factory 21: non-creator register and unconfigured hash | `04` `CON-126` + `CON-127` |
| factory 22: owner-only hash and creator-only unregister | `00` `CON-004`; `04` `CON-116`/`CON-113`/`CON-126` |
| factory 23: unregistered campaign cleanup | `01` `CON-014` |

Four cases stay offline-only because LocalNet cannot produce the state or wait
the required rounds:

| Case | Why |
| --- | --- |
| vault refund `insufficient` | Needs `paidIn - paidOut` below a valid leaf amount, which no real flow leaves behind; the offline spec patches the box |
| Factory successful `applyApprovalHash` | Needs `APPROVAL_HASH_DELAY` = 216,000 rounds; LocalNet pins the eligible round and tests early-apply rejection and cancel |
| Factory `register` payment `closeRemainderTo` | The campaign creator has an outstanding created app, so the protocol rejects the closing payment before `register` runs; the offline spec covers the guard. The pledge payment close is covered on LocalNet (`04` `CON-122`) because the backer is a plain account |
| `settleOpen` on a Claimed box with campaign status Claimed | A successful claim already settles the box to Claimed, which the box-status guard rejects first; the offline spec constructs the unreachable mixed state |

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
- `ensureBudget` OpUp loops run offline (each iteration submits one inner app
  call); size `extraFee` from the tree on LocalNet (measured table in
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
