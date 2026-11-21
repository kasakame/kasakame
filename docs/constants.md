# Constants

[`projects/constants/src/index.ts`](../projects/constants/src/index.ts) is the
single edit point for the protocol, product, fee, and AVM values shared by the
contracts, SDK, CLI, frontend, and tests. Do not add a second copy: change the
source, rebuild `dist`, and commit both.

## Entry points

- `@kasakame/constants` - compiled `dist` for runtime consumers.
- `@kasakame/constants/source` - the TypeScript source for the Puya compiler.

`dist` is committed so `file:` consumers install the package without a build
step. `check-constants` rebuilds it and fails when the committed output drifts
from `src`.

## Types

The package uses the type that fits the consumer and the value:

- `bigint` - 64-bit on-chain amounts and caps: microAlgos, the tree size, and
  fee totals. These can exceed `Number.MAX_SAFE_INTEGER`.
- `number` - counts, byte sizes, durations in seconds, page sizes, and OpUp
  coefficients. These are small enough for JSON and ordinary arithmetic.

Contracts convert at the AVM boundary with `Uint64(...)`; deploy code and tests
use `BigInt(...)`/`Number(...)` only where the consuming API requires it. The
suffixes (`_MICRO_ALGOS`, `_SECONDS`, `_BYTES`) say what the value is; the type
is a separate, deliberate choice.

## Inventory

Moved into the package:

- Campaign bounds: goal, pledge, title/metadata bytes, duration, final-day rule.
- ClaimsVault bounds: refund window.
- Registry and platform values: registration deposit, platform storage reserve.
- Claim-tree: maximum size and zero root.
- Fees: base fee, per-call extras, call totals, and group totals.
- AVM sizing: program pages, app MBR inputs, account base, vault box MBR.

Stayed contract-local:

- ARC-4 method selectors, which belong to the emitted interface.
- `MAX_UINT64`, the local overflow guard.
- `ZERO_ROOT` as parsed bytes, status codes, box layout, and the leaf domain.
- Arbitrary test vectors such as goals, deadlines, titles, and account ids.
- Generated clients and compiled artifacts.

Derived:

- `MAX_TITLE_BYTES` and `MAX_METADATA_URI_BYTES` from `MAX_STATE_KEY_BYTES`.
- Durations from `SECONDS_PER_DAY`.
- Call fees from the base fee plus extras, and group fees from call fees.
- The pinned app MBRs in `test/utils/size-budget.fixture.ts`, computed by
  `test/08-size-budget.spec.ts` from the compiled bytecode.

## Delivery

- SDK and CLI declare `@kasakame/constants` as a peer dependency and use a
  `file:../constants` devDependency for local work.
- The frontend is a private app, so it uses `file:../constants` directly.
- Contracts use the `/source` entry at compile time.
- Release order is constants, then SDK, then CLI.

The SDK's OpUp iteration math and the contract test helper's fee math are kept
as independent checks over the same shared coefficients; `formulas.spec.ts`
pins the resulting absolute fees so a coefficient change cannot silently move
both sides.

## Drift gate

`check-constants` runs `npm run build` and fails if
`git status --porcelain -- projects/constants/dist` is not empty.
`release-constants` runs the same check before publishing. A `src` change
without its rebuilt `dist` is therefore a CI failure, not a stale release.
