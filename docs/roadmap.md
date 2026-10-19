# Roadmap

This page tracks remaining work by area. Completed work is summarized under Done;
each open item links to the doc with the details. Design context is in
[`design.md`](design.md); contract behavior is in [`campaign.md`](campaign.md).

## Done

- [x] **Setup** - AlgoKit workspace, toolchain, LocalNet sandbox, lint/format/type-check, CI.
- [x] **Contract** - `create`/`pledge`/`cancelPledge`/`refund`/`claim`/`delete`
      with full behavioral + integration tests.
- [x] **Claim-tree escrow** - incremental frontier-Merkle tree: no assets, no opt-ins, no per-backer storage anywhere.
      See [`claim-tree-protocol.md`](claim-tree-protocol.md).
- [x] **Factory registry** - on-chain Factory app: owner-configured approval hash,
      `register`/`unregister` with a refundable deposit, program-hash verification against
      impostor copies. See [`architecture.md`](architecture.md).
- [x] **Split vault** - the ClaimsVault holds the backers' pooled pledges; the campaign escrow
      is never funded, so both settlement paths finalize in O(1) and failed-campaign refunds keep
      working from the vault after the campaign is deleted. Full attack matrix on LocalNet.
- [x] **Frontend core** - wallet connect (Pera/Defly), browse (Factory-filtered), create
      (+ register), pledge, claim/refund/cancel, delete.
- [x] **LocalNet deploy + seed** - Factory/ClaimsVault/Campaign deployers and a demo seed
      script (create → register → pledge).

## Frontend UX

- [ ] Backer banner on failed campaigns ("You're owed X ALGO - Refund my pledge").
- [x] **Gate creating behind connection** - disconnected visitors see a "connect wallet to
       create a campaign" prompt and a disabled New campaign button instead of a dead form.
- [x] **Single-click create** - the Create button pins the cover, pins the metadata blob,
       and creates the campaign in one flow sharing a single session (one SIWA popup per
       7 days, pre-warmed at connect); campaigns without a cover skip pinning entirely.
- [x] **Upload filenames** - cover pins keep the original file name (sanitized); metadata
       blobs are named after the campaign title. (CIDs are content-addressed either way, so
       names are display-only in Pinata.)
- [ ] **Creator display names via NFDs** - resolve NFDomains (`name.algo`) for creator/backer
       display on cards and detail, with truncated-address fallback for unnamed accounts
       (names are opt-in and cost ALGO; resolution is a free off-chain read).
- [ ] **Creator address on the campaign card** - show the campaign creator's address on the card
       (and detail page) so backers can see who's behind a campaign without leaving the listing;
       truncated-address fallback for long addresses.
- [ ] **Total backer counter** - show the number of backers who pledged on the campaign card
       and/or the campaign details page, so a campaign's traction is visible at a glance.
- [x] Fee disclaimers beside every money-moving button (see [`frontend.md`](frontend.md) fee table).
- [x] "Cancel pledge" action on open campaigns.
- [x] "Delete campaign" action for creators on settled campaigns.
- [x] **Spend-action signers** - refund/cancel/claim register the wallet signer before sending (the generated client drops `defaultSigner` when `sender` is passed explicitly, so these threw "No signer found" on a fresh page session); that error now classifies as a dead session and spend buttons require a live signer.
- [ ] Handle the known UI edge cases (indexer lag, clock drift, wallet/network mismatch) - see [`frontend.md`](frontend.md).
- [ ] **Defly first-connect fails** - the first connect attempt fails; the second succeeds. Reproduce, then fix or retry-in-place so one click is enough.
- [ ] **Wallet × platform audit** - Defly fires a `defly-wc://` deep link with no registered handler on desktop browsers. Record the expected flow per wallet (Defly/Pera/Exodus) per platform (Brave/Chrome/Firefox desktop, iOS/Android): QR, extension, or app-switch; add availability hints and fallback messaging where a flow can't work. Feeds the TestNet smoke test below.
- [ ] **Dead sessions look connected (confirmed)** - wallet-side disconnect refreshes the nav, but a silently dead bridge keeps the address + Account button (`isConnected`/`activeAddress` are store-derived, never bridge-derived). Fixed by the items below.
- [x] **Liveness revalidation** - new `lib/session.ts` `ensureLiveSessionFor()` rechecks the bridge through the adapter's silent `resumeSession()` on tab-visible and before every money-moving action; a dead bridge throws `Wallet session expired` into the existing dead-session handling.
- [x] **Nav reflects liveness** - needed no extra state: a failed revalidation clears the store via the adapter's `onDisconnect()`, and the nav already reads the store, so it flips to Connect wallet on its own.
- [x] **Backend JWT hygiene** - the cached token is keyed by address (switching wallets signs in fresh instead of reusing the previous account's token) and `clearSession()` runs on logout.
- [x] **Transaction-proof login** - uploads sign in with ARC-60 `signData` first and fall back silently to a zero self-payment proof (`POST /auth/verify-txn`) on `Method not supported`, so every wallet uploads. The `canSignData` gate is dropped as unnecessary.
- [ ] **TestNet trial: universal uploads** - trial cover + metadata upload with Defly and Exodus on TestNet, plus a Pera regression (its ARC-60 path is unchanged).
- [ ] **Indexer fallback rotation** - the app points at one indexer URL; on failure, try the next (AlgoNode, Nodely, self-hosted) instead of erroring. Free tiers have no SLA and throttle under load.
- [ ] **Persist last-known trees locally** - keep the replayed per-campaign trees in browser storage so a flaky indexer hurts less (stale roots self-heal through the existing retry-once proof rebuild).
- [ ] **Document the self-hosted escape** - alongside the CLI, document running your own node + indexer and pointing any client at it, so history never depends solely on third-party endpoints.
- [ ] **App chrome: navbar + footer** - navbar: logo left (home), search box center,
      hamburger menu right; footer: brand + `© <year> kasakame`, Contacts, Privacy
      Policy, non-custodial disclaimer. New `features/app/` components, Tailwind.
- [ ] **Search** - navbar search filters the browse list by title client-side
      (state in `CampaignList`); indexer/catalog-backed search stays a Backend item.
- [x] **Hamburger menu** - Profile, My pledges, My projects, Settings. The wallet
      button stays persistent top-right *outside* the menu: connection state must
      always be visible (see edge cases in [`frontend.md`](frontend.md)), and
      connect/disconnect is too frequent to bury behind two taps.
- [ ] **Profile section** - address + network, my projects (campaigns filtered by
      creator). My pledges shipped as its own section: live leaves via
      `fetchMyLeaves` over every enumerated campaign, deleted ones included.
- [x] **Settings section** - profile form (display name/bio/avatar/email) and settings
      form (notification prefs, theme) behind the account menu, wired to the backend CRUD.

## Frontend clarity

Informed consent before irreversible actions, in plain language - see the
transparency rule in [`AGENTS.md`](../AGENTS.md).

- [ ] **Creation is immutable (say it upfront)** - title, description, and cover can't be edited after creation; uploads pin to IPFS under our key, and while we unpin our copies on request, pinned content persists wherever else it lives. State this on the create form before submit (short notice + learn-more), not after.
- [ ] **Create progress steps** - the create flow shows exactly these steps, one bar per stage (metadata covers title, description, cover, and category in a single step), followed by the existing created message:
  1. Waiting for approval to upload metadata
  2. Uploading metadata
  3. Waiting for approval to create the campaign
  4. Creating the campaign
  5. Waiting for approval to list the campaign
  6. Listing the campaign
- [ ] **Wallet approval invitation** - separate from the steps above: a prominent element below the progress (bigger than step captions) reading "Open your wallet and confirm", shown during every waiting-for-approval state and cleared on resolve or reject. The wallet popup itself is browser chrome and not configurable; this invitation plus the vendors' in-page sign toasts (default-on, keep them on) are the layers we control.
- [ ] **Pledge receipt transparency** - after pledging, show what the backer holds: funds pooled in escrow (never paid to the creator), cancel anytime while open, automatic refund rights if the goal fails, until when (refund window end date).
- [ ] **Outcome states in plain language** - funded (creator claims, nothing needed from backers), failed (refund window with the actual end date), deleted (refunds continue from the vault; the page stays reachable via My pledges). No chain jargon.
- [ ] **Delete consequences for creators** - deleting removes the listing and returns the deposit, but changes nothing for backers: live pledges stay refundable from the vault until the window closes. Say so on the delete confirmation.

## Content & metadata

- [x] Rich off-chain rendering (IPFS image/description/category) - ARC-3-style blob rendered in card/detail via the public gateway; cover and metadata pinning flow through the backend, single-click create still open (see [`frontend.md`](frontend.md) → Campaign metadata).
- [ ] Real styled UI: design tokens, layout, cards, detail page, create flow, states, accessibility - see [`design.md`](design.md).

## TestNet & deployment

- [x] **TestNet deploy** - Factory `774437557` + ClaimsVault `774437570`, both created by the
      project wallet (owner = deployer; the deploy scripts derive a signer from its 24-word Pera
      Universal Wallet phrase via `DEPLOYER_MNEMONIC` + `DEPLOYER_ADDRESS`). Sweep target =
      deployer, 730-day window. Supersedes the initial deploy (`773811780`/`773811800`), which
      has no delete path and is left orphaned.
      View on Lora: `https://lora.algokit.io/testnet/application/<id>/`.
- [ ] **TestNet smoke test** - run create → pledge → claim and create → pledge → refund
      against the deployed apps with a real wallet (Pera/Defly). This de-risks
      wallet + public-network integration and is independent of styling.
- [x] **Lock the contract shape** - decided: no `updateMetadata()`; title and metadata URI stay immutable
      (a backer's pledge can never be re-described under them; mutability can come later via the off-chain JSON).
- [ ] Deploy the frontend to a **free static host** (GitHub Pages / Cloudflare Pages / Netlify).

## Backend & archival

The catalog is an optional minimal backend (API + DB) - see
[`architecture.md`](architecture.md). The Factory + indexer already cover
discovery and the outcome record; the catalog is for search/filter/history UX.

Backend service (`projects/backend`, Fastify + Postgres) lands in thin slices,
one commit each - CI wiring comes last:

- [x] **Scaffold** - project skeleton with a `/health` endpoint; lint/format/type-check gates green.
- [x] **Postgres + migrations** - docker compose service, migration runner, `profiles`, `settings`, and `auth_nonces` tables.
- [x] **Wallet-signature auth** - sign-in challenge (`POST /auth/challenge`, 5-minute TTL) + JWT verify (`POST /auth/verify`, HS256, 7-day tokens) + authenticated `GET /me`; no passwords, per
      [`design.md`](design.md); tests included.
- [x] **`POST /uploads`** - authenticated server-side Pinata pinning, returns the CID.
- [x] **Create-form upload** - cover picker pins through `POST /uploads` (wallet `signData` sign-in) into a readonly metadata-URI display, upload button first. Gated on the wallet's signing capability.
- [x] **Cover upload button + readonly URI** - the metadata URI renders as readonly debug text, not an editable field.
- [x] **Metadata upload** - description box plus category dropdown; an Upload metadata button pins `{name, description, image, category}` through `POST /uploads/metadata` (Name = campaign title, required) into the same display.
- [ ] **use-wallet v5 + ARC-60 sign-in** - unlocks Pera cover uploads (v5 adds Pera `signData`, but signs ARC-60 structures, so verification moves off `MX||message`). Lands in two commits, in order:
  1. [x] Frontend v5 upgrade (adapter packages, factory config, storage key, type renames). Uploads fail closed until step 2 lands.
  2. [x] ARC-60 verification end-to-end (backend verifies `sha256(data)||sha256(authenticatorData)` + domain binding; frontend sends the ARC-60 payload). Pera trial on TestNet still open - see below.
- [x] **Pera upload trial** - cover picker → Upload with Pera on TestNet passed; the URI fills in.
- [x] **Profiles + settings CRUD** - `GET /profiles?address=` (public) plus authenticated `PUT /profiles` (display name/avatar/bio/email, partial updates, null clears) and `GET`/`PUT /settings` (notification prefs, theme, defaults served when unsaved); frontend profile section reads them.
- [ ] **Per-address upload quotas** - cap uploads per address per day (small counter table, 429 + plain message when exceeded) plus an abnormal-volume alert. Signature auth stops impersonation and casual abuse; quotas only slow determined scripters (keypairs are free), so the alert matters as much as the cap.
- [ ] **Server-side image validation** - check magic bytes (not extensions), enforce dimensions, and re-encode covers (strips EXIF/metadata and doubles as malware hygiene) before pinning.
- [ ] **Takedown procedure** - unpin abusive CIDs + block the uploader address, so one bad actor can't endanger the shared Pinata account holding every legitimate campaign.
- [ ] **Funded-account gating (if abuse shows up)** - require the uploader address to hold ALGO or show on-chain history (one free indexer call). Costs attackers real money per identity, unlike keygen; costs legitimate pledgers nothing extra. Only if quotas prove insufficient.
- [x] **CI matrix** - backend lane in `build-and-test` (own job with a Postgres service; landed early, ahead of the remaining slices).

- [ ] **Minimal catalog backend** - API + DB storing one row per campaign (app id, creator, title, metadata URI, goal, deadline, status, outcome, raised, backer count), serving browse/detail pages for ended campaigns.
- [ ] **Chain watcher** - observes the indexer and finalizes campaign records (created/pledged/claimed/refunded/deleted) into the catalog.
- [ ] **Creator updates feed** - append-only, timestamped, creator-signed messages stored by the catalog and shown as history on the
      detail page; the original description stays frozen and always viewable. No contract change: signatures are verified off-chain
      against the on-chain creator address. Typos get corrected and progress gets shared, but silent rewrites stay impossible -
      the decentralized equivalent of Kickstarter's Updates tab.

## Testing

- [ ] **Browser E2E / acceptance tests** - drive the real UI against LocalNet
      (click Pledge → confirm → Cancel pledge, browse, create, claim, refund) with a
      test signer standing in for the wallet. See [`testing.md`](testing.md) →
      "Browser E2E / acceptance tests".

## SDK

The chain layer the frontend and the escape-hatch CLI share, published as
`@kasakame/sdk` - design in [`sdk.md`](sdk.md). The open items land one commit
each, in order; the last two publish the package.

- [x] **On-chain campaign headers (deleted included)** - SDK functions: enumerate campaigns from factory registry + vault boxes, recover title/metadata/goal/deadline for deleted ones by decoding the creation transaction (creator survives in the indexer; live campaigns read globals as today), and derive display status via `getCampaignStatus` (Open/Successful/Failed from status + goal + deadline + clock - never a new on-chain status). Headers keep the raw facts too (`deleted`, on-chain `status`) for completeness - e.g. reminding a creator to claim a funded-but-unclaimed campaign. Serves My pledges, the ended-list, and the CLI alike - no catalog involved.
- [x] **Fix deleted-campaign inconsistency** - `getCampaign` now recovers a deleted campaign from the same history as `fetchCampaignHeader` (creation transaction + vault box) and maps it with `campaignFromHeader` (now an SDK export), so the detail view and the deleted section of the browse list render the same fields - no more fieldless stub.
- [x] **Refund-window end-date helper** - `refundWindowEndsAt(settledAt, window)` lives in the SDK and the refund-window banner uses it, so the end date is computed in one place (the CLI can share it).
- [x] **Registration check** - `isRegistered(appId)` reads the Factory's registration box (the same fact `ClaimsVault.credit` checks on a campaign's first pledge), so pledge actions can gate on registration without simulating a call. No Factory configured means false.
- [x] **Build-without-send escape hatch** - `pledgeGroup`/`refundGroup` return the unsigned group (`TransactionWithSigner[]`, session signer attached); `pledge`/`refund` are the build-and-send wrappers for the CLI.
- [ ] **Verify exported types** - confirm every type a consumer needs (`CampaignHeader`, `CampaignViewModel`, `WalletSession`, `VaultBoxView`, `BackerLeaf`, `SdkConfig`) is exported from `@kasakame/sdk`.
- [ ] **Spec-driven codegen** - replace `projects/sdk/scripts/codegen.mjs` (and the `prebuild`
      hook) with the spec step:
  1. Obtain the specs: default is the pinned release (`gh release download
     specs-v<version> -p arc56.tar.gz` then unpack, on the version constant) -
     no contracts checkout needed;
     `SDK_SPECS=local` copies the `projects/contracts` artifacts instead, set by
     contracts-changed CI lanes and local contract work. Delete the build-if-missing branch.
  2. Regenerate each `*Client.ts` from its ARC-56 spec with the SDK's own pinned generator
     devDependency (`algokit generate client` is a wrapper around the installed
     devDependency - invoke it or its bin directly; verify the exact flags at implementation)
     and tag it `// @ts-nocheck` (verified: the clients fail the strict `tsc`).
  3. `src/generated/` stays gitignored; nothing generated is committed - regenerated every run
     from the pinned specs, so the clients can never drift from a released interface.
  4. Sync [`sdk.md`](sdk.md) (design decisions, stages), [`frontend.md`](frontend.md) (writes
     section), [`ci.md`](ci.md), and [`AGENTS.md`](../AGENTS.md) (commands).
- [ ] **Pre-publish packaging** - flip `package.json` to public, add a `files` whitelist for `dist/`, add `projects/sdk/README` (how the SDK obtains specs - the pinned release by default, `SDK_SPECS=local` against locally built contracts - how `npm run build` produces `dist/`, and how the frontend consumes the package; keep it in sync with `ci.md` and [`AGENTS.md`](../AGENTS.md) so local and CI run the same commands), and export the consumed specs version constant.
- [ ] **Publish the client SDK** - publish the versioned `@kasakame/sdk` package (claim-tree math and generated typed clients, migrating per [`sdk.md`](sdk.md)) to the public npm registry (not GitHub Packages: even public installs there need an auth token). The SDK takes indexer-provider and signer interfaces so one codebase serves the UI, the CLI, and third parties.
- [ ] **Ship the escape-hatch CLI** - graduate `scripts/reclaim.ts` into a standalone `npx`-runnable tool (refund/cancel/claim by app ID from a mnemonic, public indexer only, no backend). Canonical proof that exits never need our servers.

## CI & packaging

- [ ] Split `build-and-test.yml` into fast parallel jobs with change detection: `lint-contracts`, `test-contracts`, `lint-sdk`, `test-sdk`, `lint-frontend`, `test-frontend`, `build`, `integration-test`, `backend`. Contracts jobs only run when `projects/contracts/**` changed; SDK/frontend jobs run on every PR. Fast jobs (lint + typecheck + unit tests) run without building the contracts or the frontend bundle (the sdk lanes regenerate the clients from specs - the same-run `contracts-artifacts` when `projects/contracts/**` changed, the pinned specs release otherwise - and never build the contracts; the frontend lanes rebuild the SDK `dist/` - upload it from `build` if that proves slow); the `build` job runs contracts→SDK→frontend sequentially and uploads `contracts-artifacts`.
- [ ] Frontend resolves `@kasakame/sdk` by what a change touches: contracts/SDK changes test against the locally-built SDK `dist/` (`file:../sdk`, rebuilt from the change set's specs); frontend-only changes test against the published npm package, so routine frontend work exercises what users install (a frontend change needing an unreleased SDK API waits for its release — the published package stays truthful). SDK→frontend direction only — frontend changes never require rebuilding the SDK; the `build` and integration jobs always run local (they compile the chain anyway). Activates with the first publish.
- [ ] Final gate job: depends on all candidate jobs, passes if all are `success` or `skipped`, fails only on `failure`/`cancelled`; single required check so skipped change-detection jobs don't block merges under strict policy.
- [ ] New `release-sdk.yml` workflow: `workflow_dispatch` only, no reviewer gate (single developer). Prep job runs the `prepublishOnly` equivalent (fetch the pinned specs release → regenerate clients → `tsc` emit → lint → format → check-types → test:coverage → `npm pack --dry-run` → `npm publish --dry-run`) - node/npm only, no contracts build, so a published SDK can never embed an unreleased interface; the package records the consumed specs version. Publish job runs `npm publish` directly after prep succeeds, then builds the frontend against the exact published version (`npm pkg set dependencies.@kasakame/sdk=<version> && npm install && npm run build:testnet`) and deploys that bundle - the deployable artifact doubles as the packaging/parity test. The release chain is specs → SDK → frontend; the frontend deploy can split into its own workflow when the repos split.
- [ ] SDK consumable from repo or npm behind one specifier (`@kasakame/sdk`): once `0.1.0` is published, the committed frontend dependency is the registry version; `file:../sdk` is swapped in to test contracts/SDK changes via `npm pkg set dependencies.@kasakame/sdk="file:../sdk" && npm install` (CI: change detection, ephemeral; local: same commands, restore with `git checkout` + `npm ci`). Same commands everywhere, one specifier, different resolver.
- [ ] **Contracts → SDK consumes released specs** - the contracts rarely change, so the SDK regenerates clients from the pinned specs release by default (`gh release download specs-v<version> -p arc56.tar.gz` then unpack, on one version constant; promote to a tiny specs npm package only if the repos split). Local contract artifacts are the explicit override (`SDK_SPECS=local`): contracts-changed CI lanes and local contract work. Clients never travel between packages - the ARC-56 spec is the interface; the contracts project generates its own clients for its tests and deployer. The `build` job stays straight-line local (contracts → SDK from those artifacts → frontend) as the same-SHA end-to-end gate. A fresh clone builds the SDK without the contracts folder - the split-ready property.
- [ ] Package the frontend as a container image for portable hosting.
- [ ] **Publish the contract interface** - its own `release-specs.yml` workflow (rare - run it when the contracts change): build the contracts at the tagged commit and attach the compiled artifacts to a GitHub Release tagged `specs-vX.Y.Z` as one tarball per kind (`arc56.tar.gz`, `arc32.tar.gz`, `teal.tar.gz`, `puya.tar.gz`, each keeping the per-app directories) - ARC-56 specs (the SDK's build input; client generation), ARC-32 specs, approval/clear TEAL, and `*.puya.map` source maps (independent recompile-and-verify audits). Skip the generated `*Client.ts` - one `algokit generate client` away from the spec. They stay gitignored build output; Releases version them - nothing generated is committed.

## Open design questions

- [ ] **Residual + cleanup cadence.** Successful campaigns delete O(1) with nothing parked;
      failed campaigns hold the pool until `finalize` sweeps the residual to the treasury `sweepTarget` after the
      window (decided: see [`claim-tree-protocol.md`](claim-tree-protocol.md) → Refund window decision). Still open: whether the platform or the community drives
      `finalize` (see [`claim-tree-protocol.md`](claim-tree-protocol.md) → Refund window decision).
- [ ] **Pooled-custody review.** The vault concentrates all campaign funds; consider a
      third-party audit of the vault before TestNet.

## Product & design (later)

These are plans, not code. Details are in [`design.md`](design.md):

- [ ] Profiles & notifications (minimal backend, chain watcher, email).
- [ ] Content & UI polish, IPFS pinning, PWA + web push.
- [ ] Backers list, creator page, category filters, analytics, trust & safety.
- [ ] Resolve the open product questions (email provider, fees, backend hosting, KYC).
