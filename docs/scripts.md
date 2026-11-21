# Scripts

Operational scripts, grouped by the project that owns their dependencies. Run the `npm run` commands from the named project directory; the repository root is the default for the rest.

| Script | Purpose | Command | Prerequisites |
| --- | --- | --- | --- |
| `.github/scripts/check-release-version.mjs` | Validate a release version and the package's `version` field. | `node .github/scripts/check-release-version.mjs <package.json> <version>` | Node |
| `.github/scripts/install-algokit.sh` | Install AlgoKit 2.10.2 for CI. | `bash .github/scripts/install-algokit.sh` | CI (`GITHUB_PATH`), `pipx` |
| `.github/scripts/install-local-sdk.sh` | Install the packed local SDK when `LOCAL_SDK=true`, otherwise `npm ci`. | `bash ../../.github/scripts/install-local-sdk.sh` from a project | npm |
| `projects/contracts/scripts/advance-time.ts` | Shift the LocalNet clock and mine a block. | `SECONDS=<offset> npm run localnet:advance` | LocalNet |
| `projects/contracts/scripts/fund-account.ts` | Fund an address from the LocalNet dispenser. | `ADDRESS=<addr> [ALGO=<amount>] npm run localnet:fund` | LocalNet |
| `projects/contracts/scripts/demo/seed.ts` | Create demo campaigns and their pledges. | `npm run seed:localnet` / `npm run seed:testnet` | Registry and Vault IDs; `.env.localnet` or `.env.testnet` |
| `projects/contracts/scripts/demo/unseed.ts` | Unregister and delete the seeded campaigns. | `npm run unseed:localnet` / `npm run unseed:testnet` | The matching seed-state file |
| `projects/contracts/scripts/demo/campaigns.ts` | Demo campaign definitions consumed by `seed.ts`. | - | - |
| `projects/contracts/scripts/demo/state.ts` | Seed-state, network, and box-name helpers shared by seed/unseed. | - | - |
| `projects/contracts/scripts/demo/metadata/` | Demo metadata files (gitignored data, not a script). | - | - |
| `projects/frontend/scripts/reclaim.ts` | Reclaim and delete demo campaigns. | `npm run reclaim -- [appId...]` | Frontend `.env.testnet`, `*_MNEMONIC`; optional `SEED_STATE_PATH` |
| `projects/backend/scripts/mint-token.mjs` | Mint a throwaway session token for API testing. | `export $(node --env-file=.env scripts/mint-token.mjs)` | Backend running |
| `projects/backend/scripts/upload-image.mjs` | Upload a cover image and print its CID. | `node scripts/upload-image.mjs path/to/cover.png` | `TOKEN` from `mint-token.mjs` |
| `projects/sdk/scripts/codegen.mjs` | Regenerate the SDK clients from the pinned specs release or local artifacts. | `npm run codegen`; `SDK_SPECS=local npm run codegen` | `npm install`; built contracts for `SDK_SPECS=local` |
| `projects/sdk/scripts/generate-claimtree-vectors.py` | Regenerate the differential claim-tree vectors. | `python3 scripts/generate-claimtree-vectors.py` | Python 3 |
| `projects/sdk/scripts/smoke-package.mjs` | Pack and smoke-test the SDK tarball. | `node scripts/smoke-package.mjs` | SDK build; npm |
| `projects/cli/scripts/smoke-package.mjs` | Pack and smoke-test the CLI tarball. | `node scripts/smoke-package.mjs` | CLI build; npm |
| `docs/claim-tree-protocol-reference.py` | Language-independent reference model for the claim tree. | `python3 docs/claim-tree-protocol-reference.py` | Python 3 |
| `projects/contracts/smart_contracts/oracle.py` | Stateful oracle used by the contract tests and vector generator. | `python3 smart_contracts/oracle.py <state-file> <command>` | Python 3; moves to `contracts/test/utils` in #166 |

The shared SDK/CLI tarball smoke helper moves to `projects/utils/scripts/pack-smoke.mjs` in #164. Until then the SDK and CLI keep their own `scripts/smoke-package.mjs` copies.

## Python chain

`docs/claim-tree-protocol-reference.py` is the independent reference model. The stateful oracle wraps it for contract tests, and `generate-claimtree-vectors.py` drives both to emit the SDK's differential vectors. Keep this chain in Python: it exists to disagree with the TypeScript implementation when either side is wrong.

## CI shell

`.github/scripts/*.sh` are checked by ShellCheck in the repo-lint job; actionlint checks the workflow files. Keep multi-line shell in these scripts rather than inline in workflows.
