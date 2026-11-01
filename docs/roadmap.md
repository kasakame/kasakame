# Roadmap

This page tracks remaining work by area. Shipped work is summarized under Done;
each open item links to the doc with the details. Design context is in
[`design.md`](design.md); contract behavior is in [`campaign.md`](campaign.md).

## Done

- **Protocol** - Campaign, claim-tree escrow, Factory registry, and split ClaimsVault,
  with full behavioral + integration coverage; deployed on TestNet and smoke-tested
  (create → pledge → claim, create → pledge → refund, refund from a deleted campaign).
- **Frontend** - wallet connect (Pera/Defly/Exodus), browse, single-click create with
  IPFS pinning, pledge/cancel/refund/claim/delete, My pledges, profile/settings.
- **Backend** - Fastify + Postgres service: wallet-signature auth (ARC-60 plus the
  zero-payment fallback), profiles/settings, authenticated image and metadata uploads.
- **SDK** - `@kasakame/sdk@0.1.0` published on npm; the frontend consumes the registry
  package. See [`sdk.md`](sdk.md).
- **Releases** - contract interface published as a `specs-v0.1.0` GitHub Release
  (ARC-56/32, TEAL, source maps); `release-specs` and `release-sdk` workflows run with
  npm OIDC trusted publishing. See [`ci.md`](ci.md).
- **CI** - path-filtered `build-and-test` lanes, ShellCheck (repo-wide shell
  scripts plus workflow `run:` blocks), markdown lint, and the release workflows.
  See [`ci.md`](ci.md).
- **Identity and hosting** - GitHub/npm `kasakame` orgs and the `kasakame.com` domain
  are set up.

## Frontend UX

- [ ] **Backer banner on failed campaigns** ("You're owed X ALGO - Refund my pledge").
- [ ] **Creator display names via NFDs** - resolve NFDomains (`name.algo`) for creator/backer
       display on cards and detail, with truncated-address fallback for unnamed accounts
       (names are opt-in and cost ALGO; resolution is a free off-chain read).
- [ ] **Creator address on the campaign card** - the detail page already shows it; add it to
       the card too, with truncated-address fallback for long addresses.
- [ ] **Total backer counter** - show the number of backers who pledged on the campaign card
       and/or the campaign details page, so a campaign's traction is visible at a glance.
- [ ] **Wallet × network mismatch** - detect a wallet on the wrong chain and prompt to switch
       or reconnect before signing. Indexer lag and clock drift are already handled by the
       SDK waiters and chain timestamp.
- [ ] **Defly first-connect fails** - the first connect attempt fails; the second succeeds.
       Reproduce, then fix or retry-in-place so one click is enough.
- [ ] **Wallet × platform audit** - Defly fires a `defly-wc://` deep link with no registered
       handler on desktop browsers. Record the expected flow per wallet (Defly/Pera/Exodus) per
       platform (Brave/Chrome/Firefox desktop, iOS/Android): QR, extension, or app-switch; add
       availability hints and fallback messaging where a flow can't work. Feeds the
       TestNet upload trial below.
- [ ] **TestNet trial: universal uploads** - trial cover + metadata upload with Defly and
       Exodus on TestNet, plus a Pera regression (its ARC-60 path is unchanged).
- [ ] **Indexer fallback rotation** - the app points at one indexer URL; on failure, try the
       next (AlgoNode, Nodely, self-hosted) instead of erroring. Free tiers have no SLA and
       throttle under load.
- [ ] **Persist last-known trees locally** - keep the replayed per-campaign trees in browser
       storage so a flaky indexer hurts less (stale roots self-heal through the existing
       retry-once proof rebuild).
- [ ] **Document the self-hosted escape** - alongside the CLI, document running your own node
       + indexer and pointing any client at it, so history never depends solely on third-party
       endpoints.
- [ ] **Footer content** - add Contacts, Privacy Policy, and the non-custodial disclaimer
       beside the existing brand and `© <year> kasakame`. Navbar, hamburger menu, and the
       persistent wallet button are shipped.
- [ ] **Search** - navbar search filters the browse list by title client-side
       (state in `CampaignList`); indexer/catalog-backed search stays a Backend item.
- [ ] **Profile: network + projects** - show the active network and the creator's campaigns
       ("My projects"), replacing its "coming soon" placeholder. The profile form and My
       pledges are shipped.

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

## Backend & archival

The catalog is an optional minimal backend (API + DB) - see
[`architecture.md`](architecture.md). The Factory + indexer already cover
discovery and the outcome record; the catalog is for search/filter/history UX.

Backend service (`projects/backend`, Fastify + Postgres) runs in CI; the remaining
slices land one commit each:

- [ ] **Per-address upload quotas** - cap uploads per address per day (small counter table, 429 + plain message when exceeded) plus an abnormal-volume alert. Signature auth stops impersonation and casual abuse; quotas only slow determined scripters (keypairs are free), so the alert matters as much as the cap.
- [ ] **Server-side image validation** - check magic bytes (not extensions), enforce dimensions, and re-encode covers (strips EXIF/metadata and doubles as malware hygiene) before pinning.
- [ ] **Takedown procedure** - unpin abusive CIDs + block the uploader address, so one bad actor can't endanger the shared Pinata account holding every legitimate campaign.
- [ ] **Funded-account gating (if abuse shows up)** - require the uploader address to hold ALGO or show on-chain history (one free indexer call). Costs attackers real money per identity, unlike keygen; costs legitimate pledgers nothing extra. Only if quotas prove insufficient.
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
`@kasakame/sdk` - design in [`sdk.md`](sdk.md). The package is released; the
escape-hatch CLI is tracked in its own [CLI](#cli) section.

## CLI

- [ ] **Ship the escape-hatch CLI** - `projects/cli`, published as `@kasakame/cli`
      (`npx @kasakame/cli`): refund/withdraw/claim/delete by app ID, public algod +
      indexer only, no backend. Canonical proof that exits never need our servers.

  **Decisions**

  - **Wallet approval is the default.** `login` pairs a wallet over WalletConnect
    and stores the session locally; commands reuse it and the wallet prompts for
    every transaction group, as on the website. No account keys are stored by this
    path.
  - **WalletConnect v1, matching the wallets.** Pera and Defly pair over
    WalletConnect v1: their SDKs (`@perawallet/connect` and
    `@blockshake/defly-connect`) are v1 clients, and the apps reject v2 pairing
    URIs. The CLI uses `@perawallet/walletconnect`, the maintained v1 client Pera
    builds on, with a file-backed session, `algorand=true` pairing URIs, and the
    bridge list both wallets publish. No WalletConnect Cloud project or relay
    account is needed. The bridge is still a third-party dependency; keep the
    documented fallback.
  - **Terminal QR only for now.** `login` prints the pairing QR in the terminal
    (plus the raw `wc:` URI). A localhost page that shows the same QR is a later
    display-only option; a local browser wallet bridge (the website's Pera/Defly/
    Exodus SDKs) is not planned - it needs a browser, a local server, and a signing
    page, and only helps desktop-only users.
  - **Why WalletConnect:** it is the terminal-compatible wallet transport. Pera
    Connect and Defly Connect run on WalletConnect v1 and already implement the
    exact `algo_signTxn` flow; there is no Algorand CLI wallet-login standard yet,
    so use the stable protocol primitives rather than a vendor-specific bridge.
  - **Both signers ship.** Wallet is the default. `--signer mnemonic` is an explicit
    opt-in on any network and the only path on LocalNet (Pera/Defly cannot target
    it). It accepts a 25-word Algo25 phrase or a 24-word Pera Universal Wallet
    phrase (ARC-52 derivation; `--address` picks the account). Both produce the
    same `WalletSession`, so commands never branch. The mnemonic is read from a
    file or env, never argv, and documented as a hot key.
  - **SDK unchanged.** It already accepts any `TransactionSigner`; the
    WalletConnect adapter and mnemonic decoding belong to the CLI, not the chain
    layer.
  - **TestNet is the default**, with Factory `774437557` and ClaimsVault `774437570`.
    `--vault`/`--factory` override them; LocalNet and custom networks use
    `ALGOD_*`/`INDEXER_*`. MainNet stays out until it is deployed.
  - **Small scope:** one app id per run, `--dry-run`, one wallet approval per leaf,
    no batch operations. `delete` is in scope so creators reclaim the campaign's
    schema MBR and the Factory registration deposit from a terminal; backers keep
    refunding from the vault afterwards. `projects/frontend/scripts/reclaim.ts`
    stays as the batch dev/seed cleanup tool.
  - **Roles are explicit.** Backers withdraw or refund pledges; creators claim or
    delete campaigns. Help text, errors, and docs use those words, so nobody
    confuses withdrawing a pledge with deleting a campaign.
  - **Discovery is read-only and comes before action.** An emergency user may
    arrive with only a wallet or its mnemonic, and no app id. `pledges` and
    `campaigns` list what the address can act on, built from the SDK's Factory
    plus vault-box enumeration (which keeps deleted-but-unfinalized campaigns
    visible). No signing session, no writes. Without `--address`, the action
    column shows what the signer can run. With `--address`, the view is
    state-only: every write needs the creator's or the pledge owner's wallet.

  **Steps**

  - [x] Create `projects/cli` and scaffold the package: bin `kasakame`, ESM,
        Node 24, `@kasakame/sdk` + `@algorandfoundation/algokit-utils` + `algosdk` +
        `@walletconnect/sign-client` + `@walletconnect/keyvaluestorage` +
        `qrcode-terminal`, shared configs, lockfile, README, LICENSE, `.algokit.toml`.
  - [x] Register the Reown/WalletConnect project and wire its project ID into the
        package (env override included); confirmed the relay accepts it and returns
        a TestNet pairing URI without a web origin allowlist entry.
  - [x] Wallet session layer: `login` (terminal QR, session proposal for the
        Algorand TestNet CAIP-2 chain `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe`,
        wallet approval), `whoami`, `logout`; file-backed session store under
        `~/.kasakame/walletconnect/`, expiry/restore handling, and a clear "run
        login" error when no session matches the network.
  - [x] WalletConnect signer: wrap `algo_signTxn` (ARC-1 transaction objects,
        base64, `signers: []` for group members the wallet does not sign) as the
        standard `TransactionSigner` the SDK already accepts. No SDK or command
        changes; one wallet approval per transaction group.
  - [x] Plumb flags and config: `parseArgs`, app-id validation, network presets
        (`testnet` default, `mainnet` later, `localnet`/`custom` reading
        `ALGOD_*`/`INDEXER_*`), `--vault`/`--factory` overrides (TestNet defaults
        `774437570`/`774437557`), and `--signer wallet|mnemonic` (wallet default;
        mnemonic opt-in on any network, required on LocalNet; file/env, never argv).
        Pera and Defly do not support LocalNet, so that network always uses the
        mnemonic path. Both signers produce the same `WalletSession`, so commands do
        not branch.
  - [x] Implement backer `refund`: reject open or successful campaigns; for
        failed or deleted campaigns, fetch the signer's live pledges and refund one
        per transaction, reporting partial failures. With several live pledges,
        `--pledge <position>` picks one and `--all` refunds every one; a single
        pledge needs no flag. Open one wallet connection for the invocation and
        close it in `finally`; `--dry-run` prints the planned refunds without a
        wallet prompt.
  - [x] Implement backer `withdraw`: reject campaigns that are not open or are
        past the deadline; withdraw the signer's live pledges one per transaction,
        reporting partial failures. With several live pledges, `--pledge
        <position>` picks one and `--all` withdraws every one; a single pledge
        needs no flag. Reuse the connection lifecycle and `--dry-run` behavior
        above.
  - [x] Implement creator `claim`: reject non-creators, campaigns that are not
        successful, and already-claimed campaigns; submit the single claim and
        report the result. Reuse the connection lifecycle and `--dry-run` behavior
        above.
  - [x] Implement creator `delete`: reject non-creators, funded campaigns that are
        not claimed yet, and open campaigns with live pledges; explain that backers
        keep refunding from the vault afterwards. Delete and unregister in one
        group and report the reclaimed MBR and registration deposit. Reuse the
        connection lifecycle and `--dry-run` behavior above.
  - [x] Add read-only discovery: `pledges` lists the address's live pledges with
        campaign id, title, status, deadline, and each pledge; `campaigns` lists
        the campaigns the address created. Without `--address`, the signer view
        shows the actions it can run (`withdraw`/`refund` for its pledges,
        `claim`/`delete` for its campaigns). With `--address`, both views are
        state-only. Accept `--address` for a wallet address without a signer, so
        nobody needs an app id to start.
  - [x] Polish command output: announce each wallet approval ("waiting for
        approval"), print one clear success line per completed action, and turn
        every rejection into a message that names the next step (`pledges`,
        `campaigns`, or the right command). Keep `--dry-run` explicit that nothing
        was submitted.
  - [x] Switch the wallet transport to WalletConnect v1: Pera and Defly reject v2
        pairing URIs. Use `@perawallet/walletconnect`, append `algorand=true` to
        the pairing URI, persist the session in
        `~/.kasakame/walletconnect/testnet.json`, sign through `algo_signTxn`, and
        resolve bridges from the list the wallets publish. Drop the Reown project
        ID, the v2 relay, and the key-value storage dependency.
  - [x] Test the command module at 100% with a mocked SDK and a fake WalletConnect
        transport: happy paths, state rejections, no leaves, pledge selection, partial failure,
        invalid flags/network, missing or corrupt session, rejected approval,
        timeout, and mnemonic validation.
  - [x] Accept 24-word Pera Universal Wallet phrases: derive the account through
        ARC-52 (Peikert/Khovratovich, accounts 0-49), require `--address` to pick
        it, and keep 25-word Algo25 phrases working; both return the same
        `WalletSession`.
  - [ ] Manual TestNet smoke with `--signer mnemonic`: the phrase from a file or
        `KASAKAME_MNEMONIC`, never argv; both a 25-word Algo25 phrase and a
        24-word Pera Universal Wallet phrase with `--address`; claim, refund
        before and after a delete, and delete on a fresh campaign.
  - [x] Manual TestNet smoke with the wallet (Pera and Defly): login and account
        switching, claim, refund before the delete, delete with live refunds,
        refund after the delete, delete after claim, withdraw while open, and
        every refusal.
  - [ ] Add CI: `cli` change filter and job (format, lint, types, coverage, build),
        local SDK artifact when the SDK or contracts change, and `gate` entry. CI
        never contacts the bridge.
  - [ ] Release: `release-cli.yml` with version checks, OIDC trusted publishing +
        provenance, and a tarball smoke test running `kasakame --help`.
  - [ ] Document: new `docs/cli.md` (install, login/logout, wallet approval,
        commands, networks, the mnemonic opt-in and its hot-key trade-off, the
        WalletConnect v1 bridge dependency, self-hosting), plus `ci.md`,
        `sdk.md`, `architecture.md`, `frontend.md`, `testing.md`, `README.md`,
        `AGENTS.md`.
  - [ ] Keep `projects/frontend/scripts/reclaim.ts` as the batch dev/seed cleanup
        tool; it also deletes/unregisters, which the CLI does not.

## Wallet transport

- [ ] **Move the CLI and the frontend to WalletConnect v2** once Pera and Defly
      support it. Both pair over v1 today: their SDKs (`@perawallet/connect` and
      `@blockshake/defly-connect`) are v1 clients, so the CLI signs over v1 and the
      frontend uses the vendor SDKs. When both apps accept v2 pairing URIs, switch
      the CLI to `@walletconnect/sign-client` and the frontend to a v2 adapter,
      then drop the v1 bridge dependency. Track their release notes.

## Standardization

Publish the contract interface as an Algorand standard (ARC), with this repo as
the source for the neutral reference implementation. The standard defines the
interface and behavior. Each deployment has its own Factory + ClaimsVault, and
clients pin the deployments they trust (see
[Deployments](architecture.md#deployments)).

### Decisions

The plan settles four questions before drafting the ARC:

- **Scope.** v1 covers the Campaign and ClaimsVault ABIs, box layout and status
  values, the registry interface (`isRegistered`), and the deployment manifest.
  The ARC leaves admission policy to each deployment and names no owner or app
  ID.
- **Fee.** Optional, immutable per campaign at `create`, hard-capped, charged on
  a successful claim only (refunds stay whole). Settle this before the ABI
  freeze; if it is not ready, ship it as an extension so the freeze stays on
  schedule.
- **Sponsor.** Ecosystem or Foundation. Either moves the reference repo to
  `algorandecosystem/arcXXXX` or `algorandfoundation/arcXXXX`; Kasakame stays
  the flagship product. Decide before the Pre-ARC discussion.
- **Licensing.** Code stays MIT; the ARC text is public domain (ARC
  requirement); the Kasakame name and logo stay a trademark. No patent.

### Steps

Complete the steps in order; the interface freeze gates the spec and the ARC
submission.

- [ ] Freeze the v1 interface: write the method, box, and status tables, set the
      ABI-version policy, and settle the fee decision.
- [ ] Write `docs/standard.md` from the ARC template: abstract, motivation,
      specification, rationale, security considerations, backwards
      compatibility, reference implementation, test vectors.
- [ ] Define the deployment manifest: network, Factory and vault app IDs,
      Campaign program hash, contract version, source repo. Add an SDK helper
      that loads a manifest so clients can pin and verify a deployment.
- [ ] Build the conformance suite: run the behavioral matrix (every method ×
      every branch, plus the LocalNet adversarial cases) against any
      deployment's app IDs, with fixed claim-tree vectors.
- [ ] Check the ARC list for overlap and open the Pre-ARC discussion with the
      required fields: problem, affected users, why an ARC, related ARCs,
      expected adopters, reference implementation, and sponsor classification.
- [ ] Create the neutral reference repository (`arcXXXX`) with contracts, tests,
      deploy scripts, and an example client. Keep this repo as the product.
- [ ] Deploy the reference implementation on TestNet with an example dApp, then
      recruit one independent implementer. Documented adoption is the gate to
      `Final`.
- [ ] Open the ARC draft PR, then move through Review, Last Call, and Final with
      the tracking issue and adoption summary. Maintain the reference
      implementation.
- [ ] Align the docs: link the standard from README and architecture, and
      describe "official" as deployment-local.

## Deployment

- [ ] **Frontend** - deploy the release bundle (built against the
      published SDK) to a static host (Cloudflare Pages / GitHub Pages / Netlify) and
      point the domain at it.
- [ ] Package the frontend as a container image for portable hosting.

## Open design questions

- [ ] **Residual + cleanup cadence.** Successful campaigns delete O(1) with nothing parked;
      failed campaigns hold the pool until `finalize` sweeps the residual to the treasury `sweepTarget` after the
      window (decided: see [`claim-tree-protocol.md`](claim-tree-protocol.md) → Refund window decision). Still open: whether the platform or the community drives
      `finalize` (see [`claim-tree-protocol.md`](claim-tree-protocol.md) → Refund window decision).
- [ ] **Pooled-custody review.** The vault concentrates all campaign funds; consider a
      third-party audit of the vault before MainNet (TestNet is live).

## Product & design (later)

These are plans, not code. Details are in [`design.md`](design.md):

- [ ] Notifications (chain watcher + email/push provider).
- [ ] Content & UI polish, PWA + web push.
- [ ] Backers list, creator page, category filters, analytics, trust & safety.
- [ ] Resolve the open product questions (email provider, fees, backend hosting, KYC).
