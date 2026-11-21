# @kasakame/constants

Public, dependency-free constants shared by the kasakame contracts, SDK, CLI, and frontend.

The package has two entry points for one source file:

- `@kasakame/constants` loads the compiled JavaScript and declarations from `dist`.
- `@kasakame/constants/source` loads `src/index.ts` for the Puya contract compiler.

The `/source` entry exists because Puya inlines compile-time values. A compiled `.js`/`.d.ts` package cannot provide those values: the compiler either rejects it or emits empty bytecode. Contracts import `/source`; runtime consumers import the package normally.

`dist` is built from `src` with `tsc` and committed to the repository so
file-dependency consumers install it without a build step. Rebuild and commit
`dist` together with any `src` change; CI rebuilds and fails if they drift.

## Contents

One `src/index.ts` with direct `export const` declarations: protocol bounds and
durations, fees and OpUp budget coefficients, and AVM page/account/app/box MBR
inputs. Contracts import the same source through `/source`; runtime consumers
import the compiled package.

Values use `bigint` for 64-bit on-chain amounts and caps (microAlgos, tree
size, fee totals) and `number` for counts, byte sizes, seconds, page sizes, and
OpUp coefficients. Contracts convert at the AVM boundary with `Uint64(...)`.
See [`docs/constants.md`](../../docs/constants.md) for the full inventory and
the delivery and drift rules.

## Commands

```bash
npm run build
npm run check-types
npm run lint
npm run format
```
