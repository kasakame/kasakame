# @kasakame/utils

Private, repo-only helpers shared by the kasakame projects. Never published.

- `@kasakame/utils` - program-hash helpers for the deploy code and tests.
- `@kasakame/utils/testing` - LocalNet platform deploy, account/ledger reads,
  time travel, byte/selector helpers, and Node-`assert` checks. Test-only; it
  imports `algokit-utils` and `algosdk`, but no test runner, so consumers keep
  Vitest or any other runner.
- `release/` and `smoke/` - the release workflow scripts and the per-package
  smoke entries, run with Node 24 type stripping. They stay out of the packed
  package (`files` lists only `program-hash.ts` and `testing/`).
- `scripts/check-comments.ts` - the repo-wide one-line, 200-character comment
  rule; run `npm run check:comments` or `node scripts/check-comments.ts --report`
  for the baseline table.

Contract-only helpers (campaign flows, the claim-tree oracle, scale knobs) stay
in `projects/contracts/test/utils`.

## Use

Packages install it from the repo with a `file:` dependency. Each consumer's
`.npmrc` sets `install-links = true`, so npm packs the package into the
consumer's `node_modules` and resolves its dependencies there (a plain symlink
would look for them under `projects/utils`). Re-run `npm install` after editing
the package, or `npm ci` for a clean copy.

The `file:` link is in each consumer's `package.json`, so `npm ci` restores it.

## Commands

```bash
npm run check-types
npm run lint
npm run format
```
