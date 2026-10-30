# CI

This page describes the GitHub Actions setup: a consolidated
[`build-and-test`](.github/workflows/build-and-test.yml) workflow,
a separate [`markdown-lint`](.github/workflows/markdown-lint.yml), and the
manual [`release-specs`](.github/workflows/release-specs.yml) release - plus
the reasoning behind the splits.

## Principles

- **Build once, share the output.** The compiled contract artifacts (TEAL +
  ARC specs) are gitignored and regenerable. When the contracts change,
  `build-contracts` compiles them once and uploads `contracts-artifacts`; the
  SDK lanes, the frontend lanes, `build`, and `integration-test` download it
  instead of recompiling. The SDK never copies generated clients between
  projects: it regenerates them from the ARC-56 specs, from the downloaded
  artifacts (`SDK_SPECS=local`) in contracts-changed runs and from the pinned
  release otherwise.
- **Split by prerequisites.** Lint, format, type-check, and unit-test jobs need
  only Node.js; `build-contracts` adds Python for the AlgoKit CLI (contract
  compilation) and `integration-test` adds Docker for LocalNet too. Keeping
  those in separate jobs (not separate workflows) keeps feedback fast and
  failures attributable to the right lane.
- **Change detection, not matrices.** One `changes` job runs
  [`dorny/paths-filter`](https://github.com/dorny/paths-filter) and decides
  what every other job runs against. The filters encode the dependency graph:
  `sdk` includes the SDK and contracts, `frontend` includes the frontend, SDK,
  and contracts, and `backend` is independent. A path outside the four
  projects (workflows, root config, a new project) enables every lane. Markdown
  files and `.markdownlint-cli2.jsonc` run no code lane (the separate markdown
  workflow owns them). Separate jobs (no matrix) keep the conditional presence
  and the status-check names stable.
- **The frontend resolves the SDK by what changed.** A frontend-only change
  installs the published `@kasakame/sdk`, so routine frontend work exercises
  what users install; an SDK or contracts change builds the local SDK and
  installs that copy instead (see below). The `build` job bundles the frontend
  against the local SDK as the same-SHA end-to-end gate whenever the web stack
  or a shared path changed. The backend runs as its own job (it needs a
  Postgres service, so it doesn't fit the pure-Node jobs).
- **CI calls the per-project npm scripts directly** (`npm run lint`, …), not
  `algokit project run`. The algokit wrapper is a local convenience and runs
  projects sequentially.
- **Run once per change.** Both workflows trigger on `pull_request` (any branch)
  and on `push` to `main` only - a same-repo branch would otherwise fire both
  `push` and `pull_request` events and run everything twice.

## Job graph

```mermaid
flowchart TD
    changes["changes<br/>(changed paths)"]
    buildc["build-contracts<br/>(when contracts or shared changed)"]
    contracts["lint-contracts / test-contracts<br/>(when contracts or shared changed)"]
    sdk["lint-sdk / test-sdk<br/>(when contracts, sdk, or shared changed)"]
    frontend["lint-frontend / test-frontend<br/>(when contracts, sdk, frontend, or shared changed)"]
    build["build<br/>(SDK + Vite bundle, local SDK)"]
    integration["integration-test<br/>(when contracts or shared changed)"]
    backend["backend<br/>(when backend or shared changed)"]
    gate["gate<br/>(single required check)"]

    changes --> buildc
    changes --> contracts
    changes --> sdk
    changes --> frontend
    changes --> build
    changes --> backend
    buildc -->|"contracts artifacts"| sdk
    buildc -->|"contracts artifacts"| frontend
    buildc -->|"contracts artifacts"| build
    buildc -->|"contracts artifacts"| integration
    changes --> gate
    buildc --> gate
    contracts --> gate
    sdk --> gate
    frontend --> gate
    build --> gate
    integration --> gate
    backend --> gate
```

## What each job needs

| Job | Runs when | Node.js | AlgoKit CLI | Docker | Artifacts it consumes |
| --- | --- | --- | --- | --- | --- |
| `changes` | always | - | - | - | - |
| `build-contracts` | contracts or shared changed | ✅ | ✅ | - | - (produces `contracts-artifacts`) |
| `lint-contracts` / `test-contracts` | contracts or shared changed | ✅ | - | - | - |
| `lint-sdk` / `test-sdk` | contracts, SDK, or shared changed | ✅ | - | - | contracts artifacts (contracts-changed runs) |
| `lint-frontend` / `test-frontend` | contracts, SDK, frontend, or shared changed | ✅ | - | - | contracts artifacts (contracts-changed runs); local SDK copy (SDK/contracts-changed runs) |
| `build` | contracts, SDK, frontend, or shared changed | ✅ | - | - | contracts artifacts (contracts-changed runs) |
| `backend` | backend or shared changed | ✅ | - | ✅ (Postgres service) | - |
| `integration-test` | contracts or shared changed | ✅ | ✅ | ✅ (algod + indexer) | contracts artifacts |
| `gate` | always | ✅ (runner only) | - | - | - |
| `markdown-lint` (own workflow) | markdown or its config changed | ✅ | - | - | - |
| `release-specs` (own workflow) | manual | ✅ | ✅ | - | - |

Key point: **lint/format/type-check, unit-test, and markdown are pure Node**.
`eslint`, `prettier`, `tsc`, `vitest`, and `markdownlint-cli2` need no Docker
or AlgoKit install. The contracts jobs do not build anything: the offline
contract suite runs the contract source directly, and only `build-contracts`
compiles. The SDK lanes run codegen against the same-run artifacts or the
pinned release; the frontend lanes install the published SDK or a packed local
copy - see below. The backend lane is the exception: its suite runs against a
throwaway Postgres service (migrations first, like local development).

## Why the SDK lanes need same-run contract artifacts

The SDK's write path imports the generated clients (`src/generated/*`,
gitignored), which `scripts/codegen.mjs` regenerates from ARC-56 specs with the
pinned `@algorandfoundation/algokit-client-generator`. By default codegen
downloads the pinned `specs-v<version>` release asset over HTTPS
(`.../releases/download/specs-v<version>/arc56.tar.gz`), so it needs no `gh`
login; `SDK_SPECS=local` reads
`projects/contracts/smart_contracts/artifacts` instead. On a
contracts-changed run the SDK lanes download `contracts-artifacts` and run
codegen with `SDK_SPECS=local`, so type-check and tests resolve the clients
against the change set's contracts; otherwise they use the pinned release.
Codegen never builds the contracts: local mode fails with instructions if the
artifacts are absent.

## How the frontend jobs resolve the SDK

The committed frontend dependency is `"@kasakame/sdk": "^0.1.0"` (see
[`sdk.md`](sdk.md)). On a frontend-only change the frontend lanes install it
from the registry with `npm ci`, so routine frontend work exercises exactly
what users install.

When the SDK or the contracts changed, the lanes build the SDK first
(`npm ci` + `npm run build` in `projects/sdk`; codegen uses the same-run
artifacts when the contracts changed, the pinned release otherwise) and then
install it as a packed copy:

```sh
npm install --no-save --install-links "file:../sdk"
```

`--install-links` packs the SDK directory and installs it like a tarball (same
shape as the published package) instead of symlinking it; `--no-save` leaves
`package.json`/`package-lock.json` untouched. A plain `npm ci` afterwards
restores the published package. Local contract/SDK work uses the same command
(build the SDK first), so there is nothing to revert.

The `build` job is the same-SHA gate: when it runs, it builds the local SDK and
bundles the frontend against that copy - from the same-run artifacts when the
contracts changed, from the pinned release otherwise.

## Workflow: build-and-test

Implemented at `.github/workflows/build-and-test.yml`. Twelve jobs. `changes`
runs `dorny/paths-filter@v4.0.3`: PRs use the changed-files API (hence
`pull-requests: read`), and pushes to `main` diff against the previous commit
on the branch (`github.ref` as the base on pushes). The filters encode the
dependency graph, and markdown files plus `.markdownlint-cli2.jsonc` are
excluded from every filter. It exposes six outputs:

- `contracts`, `sdk`, `frontend`, `backend` - run that lane. The filter already
  folds in its inputs: `sdk` is SDK or contracts, `frontend` is frontend, SDK,
  or contracts.
- `shared` - any path outside the four projects except markdown and the
  markdownlint config (workflow, root config, new project); every lane ORs it,
  so shared changes are never silently skipped.
- `local_sdk` - same as `sdk`: the frontend lanes build the local SDK when the
  SDK or contracts changed.

- **`changes`** - checkout with `fetch-depth: 0`, the paths-filter action, and
  the outputs; no Node setup, seconds of work.
- **`build-contracts`** - runs when `contracts` or `shared` is true. Installs
  Node + AlgoKit, compiles the contracts (`npm run build` → TEAL + ARC-56 specs
  and generated clients), and uploads `contracts-artifacts`.
- **`lint-contracts` / `test-contracts`** - run when `contracts` or `shared` is
  true; pure Node (`npm ci`, then lint/format/type-check or
  `npm run test:coverage`).
- **`lint-sdk` / `test-sdk`** - run when `sdk` or `shared` is true (`sdk` covers
  the SDK and contracts). When the contracts changed they download
  `contracts-artifacts` and codegen with `SDK_SPECS=local`; otherwise codegen
  downloads the pinned specs release. Then lint/format/type-check or
  `npm run test:coverage`.
- **`lint-frontend` / `test-frontend`** - run when `frontend` or `shared` is
  true (`frontend` covers the frontend, SDK, and contracts). When `local_sdk`
  is true they build the SDK (same-run artifacts or pinned release) and install
  the packed copy (`npm install --no-save --install-links "file:../sdk"`);
  otherwise they install the published package with `npm ci`. Then
  lint/format/type-check or `npm run test:coverage`.
- **`build`** - runs when `frontend` or `shared` is true. Builds the local SDK
  (same-run artifacts or pinned release), installs the packed copy into the
  frontend, and bundles it (`npx vite build`) - the same-SHA end-to-end gate.
- **`integration-test`** - runs when `contracts` or `shared` is true: downloads
  `contracts-artifacts`, starts LocalNet, and runs the compiled TEAL against a
  live algod.
- **`backend`** - runs when `backend` or `shared` is true: starts a Postgres
  service, runs migrations, then lint, format, type-check, and
  `npm run test:coverage` - the same sequence as local development.
- **`gate`** - depends on all of the above and passes when every job is
  `success` or `skipped`; it fails on `failure`/`cancelled`. Branch protection
  requires only this check, so skipped jobs don't block a merge.

`npm run format` runs Prettier in `--check` mode, so style drift fails the build
without modifying files.

## Workflow: markdown-lint (separate file)

Implemented at `.github/workflows/markdown-lint.yml`. Markdown linting keeps its
**own workflow file**, because triggers live at the workflow level - a job
cannot have a different trigger than its workflow - and its `paths:` filter
(markdown files and `.markdownlint-cli2.jsonc`) is independent of the code
change detection. A markdown-only change therefore runs only this workflow and,
in `build-and-test`, `changes` + `gate` (every code lane skips); a mixed change
runs both.

The catch: a `paths`-filtered workflow cannot be a required status check,
because it never reports on PRs that touch no markdown, leaving the check
"Expected". It stays advisory unless it is folded into `Gate` as an always-run
job. The lint command checks all `*.md` files.

## Workflow: release-specs (separate file)

Implemented at `.github/workflows/release-specs.yml`. Manual (`workflow_dispatch`)
release of the **contract interface**: it builds the contracts from the
dispatched commit, runs the offline contract tests, and attaches the compiled
per-app artifacts to a GitHub Release tagged `specs-v<version>` as one tarball
per artifact kind - `arc56.tar.gz` (ARC-56 specs), `arc32.tar.gz` (ARC-32
specs), `teal.tar.gz` (approval/clear TEAL), and `puya.tar.gz` (`*.puya.map`
source maps) - each keeping the per-app directories. Generated clients are
never attached. Its own file because it is a release, not a CI gate: it runs
manually (contracts rarely change) and needs `contents: write` to create the
release. The version is a dispatch input and must match
`projects/contracts/package.json`; bump that version in the release commit. The
specs series is independent of the published npm packages, started at `0.1.0`.
`prerelease` defaults on while the interface can still break on TestNet; GitHub
pre-release status only affects the "Latest" label, not downloads by tag.

The SDK pins `specs-v<version>` in `projects/sdk/package.json`
(`config.specsVersion`), downloads the public `arc56.tar.gz` asset over HTTPS by
default, and regenerates its clients from those specs with its own pinned
generator; `SDK_SPECS=local` uses
the contracts project's artifacts for contracts-changed lanes and local contract
work. Nothing generated is committed. The other tarballs serve deployers and
verifiers - the ARC-32 specs for legacy tooling and the TEAL + source maps for
independent recompile-and-verify audits.

## Workflow: release-sdk (separate file)

Implemented at `.github/workflows/release-sdk.yml`. Manual (`workflow_dispatch`)
release of `@kasakame/sdk`; no reviewer gate (single developer). The version is
`projects/sdk/package.json`; bump it in the release commit. The dispatch inputs
are:

- `version`: required, without the `v` prefix; must match the package version.
- `dry_run`: defaults to `true`; runs the gate, smoke test, package inspection,
  and the prep publish dry-run, but skips the real publish and registry check.

Prerelease versions publish under the `next` dist-tag, finals under `latest`.

- `prep` is Node/npm only and never builds the contracts: install, validate the
  input version against `package.json` and that it is unpublished, regenerate
  clients from the pinned `specs-vX.Y.Z` release, compile TypeScript, lint,
  format, type-check, run coverage, inspect the packed tarball, and dry-run the
  publish. Each command is its own step. It uploads the tested `dist/`.
- `smoke` runs `projects/sdk/scripts/smoke-package.mjs`: it packs the tested
  `dist/`, installs the tarball into a clean consumer, checks the version and
  `LICENSE`, imports the public API, and verifies `SPECS_VERSION` against the
  pin. It gates the publish.
- `publish` downloads the tested `dist/`, verifies the package files and
  version, and, when `dry_run=false`, publishes with the `next`/`latest`
  dist-tag through npm OIDC trusted publishing (`id-token: write`) with
  `--provenance`. It then polls the registry for the version, allowing 10
  minutes: npm stages a new package and the first publish took about 2.5
  minutes to become visible. A dry run stops before the publish and registry
  check.

Configure the trusted publisher for `@kasakame/sdk` on npmjs.com (package
Settings → Trusted Publisher) with GitHub owner `kasakame`, repository
`kasakame`, workflow `release-sdk.yml`, and no environment. Enable **Allow npm
publish**; leave **Allow npm dist-tag** off, because the workflow only passes
`--tag` to `npm publish` and never runs `npm dist-tag`. `npm stage publish` is
always allowed and needs no opt-in. The `npm trust github` CLI is the
equivalent (`--allow-publish`).

A new trusted publisher must complete its first publish within 2 days or it
expires and must be recreated. OIDC publishes do not prompt for 2FA: the job
exchanges the GitHub identity for a short-lived token. 2FA still gates
interactive actions (npmjs.com login, `npm trust`, and `npm stage approve`).
After the first OIDC publish succeeds, set the package's Publishing access to
"Require two-factor authentication and disallow tokens", delete the
`NPM_TOKEN` GitHub secret, and revoke the bootstrap token.

The frontend is built by its own release/deploy workflow against the published
version; it is not part of the SDK release.

Then dispatch the workflow from `main` with `dry_run=false`.

## Release and distribution

These decisions cover how the protocol and its clients ship; the implementation
order is in [`roadmap.md`](roadmap.md) (SDK and CI & packaging sections).

| Artifact | Canonical channel | Version | Notes |
| --- | --- | --- | --- |
| ARC-56/ARC-32 specs, TEAL, source maps | GitHub Release | `specs-vX.Y.Z` | One tarball per kind; the audit bundle. |
| `@kasakame/sdk` | npm | `X.Y.Z` (independent) | The only contract consumer; records the specs version it was built against. |
| `@kasakame/cli` | npm | `X.Y.Z` | Depends on the SDK; public indexer only, no backend. |
| Frontend | static host | deploy | Built against a published SDK for frontend-only changes. |
| Backend | deploy | - | Optional service; not an npm package. |

- **No specs npm package for now.** GitHub Releases stay canonical for ARC-56,
  ARC-32, TEAL, and source maps. Raw ARC-56 packages are uncommon, and the SDK
  ships generated clients, so a second channel adds maintenance without a
  consumer. The public release asset downloads over HTTPS without `gh` (a
  private repo would need an authenticated download). Revisit only if the SDK
  must build with only `npm ci` (no release download), external consumers need
  spec-only installs, the contracts repo becomes private after a split, or
  npm-native interface versioning is wanted.
- **If specs go to npm later**, publish a thin `@kasakame/specs` mirror from
  the same `release-specs` workflow at the same commit and version, primarily
  ARC-56; the GitHub release remains the canonical audit bundle. Never
  hand-maintain two copies.
- **Generated artifacts are never committed.** The contracts deployer and the
  SDK are the only client generators; the frontend and CLI consume the SDK.
  Everything is regenerated from the pinned specs with the pinned generator.

### Versions and release order

- `specs-vX.Y.Z` is the `projects/contracts/package.json` version; it is
  independent of the published npm package versions. The SDK pins the consumed
  specs version in `package.json` (`config.specsVersion`) and exports it as
  `SPECS_VERSION`.
- Both release workflows validate the dispatch version against their project
  `package.json` with `.github/scripts/check-release-version.mjs`.
- Release in order: contracts → specs release → SDK → frontend/CLI. A
  frontend-only change tests and deploys against the published SDK.
- Publish `0.1.0-rc.N` before `0.1.0`. The workflow maps prerelease versions to
  the `next` dist-tag and finals to `latest`; npm versions and `specs-v*` tags
  are never reused.

### npm publishing

- Publish only `@kasakame/sdk`, then `@kasakame/cli`. Both are public packages
  with a `files` whitelist.
- The SDK publishes only `dist/` plus the package metadata, README, and
  `LICENSE`; `publishConfig.access: "public"` makes the scoped package public.
- Published packages carry the root MIT `LICENSE` (copy it into each package
  directory) and declare `"license": "MIT"` in `package.json`.
- The `release-sdk` workflow uses npm OIDC trusted publishing; every publish
  passes `--provenance`. Set the package's publishing access to "Require
  two-factor authentication and disallow tokens" so only the trusted publisher
  can publish.
- **Planned hardening:** enable GitHub immutable releases for `specs-v*`,
  attach a `SHA256SUMS` asset, and verify it in the SDK codegen. Until then, the
  tag is the pin.
- The SDK must build without the contracts checkout: codegen downloads the
  pinned release by default. `SDK_SPECS=local` is the explicit override for
  contracts-changed lanes and local contract work.

### Repository shape

- Stay a monorepo for now; deployment layout is independent of repository
  layout. The SDK's spec-only build is what makes a split possible.
- Split only on a trigger: separate access/audit boundaries, divergent release
  cadence, CI cost, external teams, or conflicting deploy pipelines. A split
  moves contracts to its own repo, releases specs from there, and adds a
  separate SDK repo that pins those releases; the frontend then pins published
  SDK versions.

## Testing taxonomy

Contracts and frontend test differently. Contract suites are offline AVM tests
with a 100% lines/branches/functions gate; frontend suites are Vitest unit +
component tests with a 100% gate on components and utils. The SDK's suite is
pure Vitest over the chain layer (claim-tree math, replay, campaign reads, and
writes) with a 100% gate on `src`; its lane runs the codegen first (from the
same-run artifacts with `SDK_SPECS=local`, or the pinned release) so the
generated clients resolve at import time. All are
described in [`testing.md`](testing.md) (contracts) and
[`frontend.md`](frontend.md) (frontend).

The offline contract tests don't need the AlgoKit CLI or Docker because the
`algorand-typescript-testing` transformer runs the contract source directly
under Node - the contracts jobs are pure Node and consume nothing from
`build-contracts`, never the compiled TEAL. The SDK lanes download
`contracts-artifacts` on contracts-changed runs (see above for why); the
frontend lanes install the published SDK or a packed local copy.

## Caching

No custom Docker image is built or pulled for any job. Tooling installs on
the runner and caches:

- **Node** - `actions/setup-node@v7` with `cache: npm` and
  `cache-dependency-path` pointing at the project's `package-lock.json` (the
  frontend jobs list the SDK lockfile too, because they may build it). This
  caches `node_modules`, so `npm ci` is ~seconds on cache hits.
- **AlgoKit (Python)** - installed fresh via `pipx` in the `build-contracts`
  and `integration-test` jobs (not cached). The install is fast relative to the
  Docker container startup that dominates the integration job.

The only Docker in CI is **prebuilt** images: the Postgres service (backend
job) and the algod/indexer sandbox (integration job, pulled only there). If runner install time ever justifies a custom
CI image, publish it once to GHCR and rebuild only when its `Dockerfile` changes.

## Artifacts - sharing build output between jobs

`build-contracts` uploads one artifact that the other jobs download when the
contracts changed, so nothing is compiled twice:

- **`contracts-artifacts`** - `projects/contracts/smart_contracts/artifacts`
  (TEAL, ARC-32/56 specs). Consumed by `integration-test`, by the SDK lanes
  (they regenerate clients from it with `SDK_SPECS=local`), and by the frontend
  lanes and `build` (their local SDK builds use it as the codegen input).
