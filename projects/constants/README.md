# @kasakame/constants

Public, dependency-free constants shared by the kasakame contracts, SDK, CLI, and frontend.

## Install

```bash
npm install @kasakame/constants
```

Node.js 24 or newer, ESM.

## Use

Runtime consumers import the compiled package:

```ts
import { MAX_TREE_SIZE, ZERO_ROOT_HEX } from '@kasakame/constants'
```

Contracts import the source entry so Puya inlines the values at compile time:

```ts
import { MAX_TREE_SIZE } from '@kasakame/constants/source'
```

The package has two entry points for one source file:

- `@kasakame/constants` loads the compiled JavaScript and declarations from `dist`.
- `@kasakame/constants/source` loads `src/index.ts` for the Puya contract compiler.

The `/source` entry exists because Puya inlines compile-time values. A compiled `.js`/`.d.ts` package cannot provide those values: the compiler either rejects it or emits empty bytecode. Contracts import `/source`; runtime consumers import the package normally.

`dist` is built from `src` with `tsc` and committed to the repository so
file-dependency consumers install it without a build step. Rebuild and commit
`dist` together with any `src` change; CI rebuilds and fails if they drift.

## Contents

One `src/index.ts`, grouped into commented sections:

- **Units and claim tree** - microAlgos per ALGO, `MAX_UINT64`, the
  `MAX_TREE_SIZE` cap, the zero root, and the leaf domain.
- **Campaign bounds and durations** - goal, pledge, title, metadata URI,
  duration, and refund-window limits.
- **Storage costs** - box MBR inputs, the registration deposit, the campaign
  box MBR, and the platform storage reserve.
- **Fees and group totals** - the base fee, inner-transaction counts, extra
  fees, call totals, and group totals.
- **OpUp budget** - pledge and spend costs and the take coefficients.
- **AVM program and app MBR inputs** - page size, extra pages, account base,
  and the app MBR coefficients.
- **Protocol encodings** - campaign and vault box statuses, the packed vault
  box layout, box prefixes, and app-id/address byte sizes.

| Encoding         | Value                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Campaign status  | `0` Open, `1` Failed, `2` Claimed                                                          |
| Vault box status | `01` Open, `02` Failed, `03` Claimed                                                       |
| Vault box        | 65 bytes: `paidIn` 0, `paidOut` 8, `root` 16, `n` 48, `status` 56, `settledAt` 57          |
| Leaf domain      | `0x01`                                                                                     |
| Box key          | one-byte prefix (`c` vault campaign, `r` Registry registration) + 8-byte big-endian app id |
| Box MBR          | 2,500 + 400 × (key bytes + value bytes) microAlgos                                         |

Contracts import the same source through `/source`; runtime consumers import
the compiled package. Values use `bigint` for 64-bit on-chain amounts and caps
(microAlgos, tree size, fee totals) and `number` for counts, byte sizes,
seconds, page sizes, and OpUp coefficients. Contracts convert at the AVM
boundary with `Uint64(...)`.

## Commands

```bash
npm run build
npm run check-types
npm run lint
npm run format
```

## License

MIT. See [LICENSE](https://github.com/kasakame/kasakame/blob/main/projects/constants/LICENSE).
