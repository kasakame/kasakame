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
- **CI** - path-filtered `build-and-test` lanes, markdown lint, and the release
  workflows. See [`ci.md`](ci.md).
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
`@kasakame/sdk` - design in [`sdk.md`](sdk.md). The package is released; one item
remains:

- [ ] **Ship the escape-hatch CLI** - graduate `scripts/reclaim.ts` into a standalone `npx`-runnable tool (refund/cancel/claim by app ID from a mnemonic, public indexer only, no backend). Canonical proof that exits never need our servers.

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
