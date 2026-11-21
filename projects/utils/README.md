# @kasakame/utils

Private, repo-only helpers shared by the kasakame projects. Never published.

- `@kasakame/utils` - production-neutral bytes, selector, and program-hash
  helpers.
- `@kasakame/utils/testing` - LocalNet platform deploy, account/ledger reads,
  time travel, and Node-`assert` checks. Test-only; it imports `algokit-utils`
  and `algosdk`, but no test runner, so consumers keep Vitest or any other
  runner.

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
