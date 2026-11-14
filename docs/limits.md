# Limits, sizes, storage, and fees

Single source of truth for the AVM/Algorand limits and the current cost of the
kasakame contracts. Read this before changing any contract code; update it in the
same change set when a size, storage, group shape, or fee changes.

The current numbers are the compiled bytecode from `npm run build` on 2026-11-06,
not the `.teal` source size. Re-measure after any contract change.

## Hard AVM / Algorand limits

| Limit | Value | Notes |
| --- | --- | --- |
| Approval + clear program size | 2,048 B combined base | `MaxAppTotalProgramLen`; each extra page adds 2,048 B total |
| Extra program pages | 3 without fee surcharge | `MaxExtraAppProgramPages`; newer consensus (AVM 13/v42) allows up to 7 with a fee surcharge (`MaxAbsoluteExtraProgramPages`) |
| Extra page MBR | 100,000 µA per page | charged to the app creator (or size sponsor) |
| Opcode budget | 700 per app call | `MaxAppProgramCost`; pooled across a group; inner app calls add 700 each |
| App args | 16 max, 2,048 B total | `MaxAppArgs`, `MaxAppTotalArgLen`; up to 16,384 B with a fee surcharge |
| Global state | 64 entries | key ≤ 64 B; byte value ≤ 128 B; key + value ≤ 128 B |
| Local state | 16 entries | no local state is used by these contracts |
| Box | name ≤ 64 B, value ≤ 32,768 B | MBR 2,500 + 400 × (name + value) µA; 8 box refs per call |
| Box IO | 2,048 B per box reference | `BytesPerBoxReference` (older docs say 1,024; the current parameter is 2,048) |
| Foreign references | 8 total per app call | accounts + assets + apps + boxes (`MaxAppTotalTxnReferences`); 8 per type (`MaxAppTxnAccounts`, `MaxAppTxnForeignAssets`, `MaxAppTxnForeignApps`) |
| Access list | 16 entries | `MaxAppAccess`; newer `txn.Access`; not used by these contracts |
| Inner transactions | 16 per app call, 256 per group | `MaxInnerTransactions` × group size; the protocol uses at most 5 inner txns per operation |
| Group size | 16 top-level txns | `MaxTxGroupSize` |
| Stack | 1,000 entries; byte array ≤ 4,096 B | `MaxStackDepth`, `MaxStackSize` |
| Logs | 32 calls, 1,024 B each | not used by these contracts |
| Minimum fee | 1,000 µA per txn | `MinTxnFee` |
| Larger-transaction fee | +1,000 µA per 1,000 B | a 2,267 B transaction needs 3,000 µA; inner txn fees are paid from the group fee pool |
| Account base MBR | 100,000 µA | app accounts with boxes must hold this; the campaign app account holds 0 |
| App creation MBR | 100,000 + 50,000 × global bytes + 28,500 × global uints + 100,000 × extra pages | charged to the creator |
| App opt-in MBR | 100,000 + 50,000 × local bytes + 28,500 × local uints | charged to the opted-in account; not used |
| Box MBR | 2,500 + 400 × (name + value) | charged to the app account that owns the box |

Sources: [protocol parameters](https://dev.algorand.co/concepts/protocol/protocol-parameters/),
[smart-contract costs and constraints](https://dev.algorand.co/concepts/smart-contracts/costs-constraints/),
[ledger parameters](https://specs.algorand.co/ledger/ledger-parameters),
[fees](https://dev.algorand.co/concepts/transactions/fees/), and the
[AVM reference](https://dev.algorand.co/concepts/smart-contracts/avm/).

> The no-surcharge page limit is 3 extra pages. Do not rely on the larger
> 7-extra-page limit unless the target network's consensus supports it and the
> fee surcharge is acceptable.

## Current compiled footprint

Measured from `smart_contracts/artifacts/*/*.arc56.json` (`byteCode.approval` +
`byteCode.clear`).

| Contract | Approval | Clear | Total | Extra pages | Page capacity | Headroom to next page |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Campaign | 2,112 B | 4 B | 2,116 B | 1 (2 pages) | 4,096 B | 1,980 B |
| ClaimsVault | 2,774 B | 4 B | 2,778 B | 1 (2 pages) | 4,096 B | 1,318 B |
| Factory | 1,032 B | 4 B | 1,036 B | 0 (1 page) | 2,048 B | 1,012 B |

The campaign is **68 bytes over** the 1-page (2,048 B) limit. It is already a
2-page app; the next page boundary is 4,096 B. Trimming 68 B would return it to
one page and save 100,000 µA of creator MBR.

`npm run test:size` pins these values in
`smart_contracts/size-budget.fixture.ts` and runs in the `compile-contracts` CI
job after `npm run build`. A byte, page, or schema change must update the fixture
and this table together.

## Current app MBR and storage

| Contract | Global schema | Extra pages | App MBR | Who pays | Local state |
| --- | --- | ---: | ---: | --- | --- |
| Campaign | 4 byte-slices + 6 uints | 1 | **571,000 µA** | creator's account | none |
| ClaimsVault | 1 byte-slice + 2 uints | 1 | **307,000 µA** | platform/deployer | none |
| Factory | 4 byte-slices + 2 uints | 0 | **357,000 µA** | platform/deployer | none |

- Campaign app MBR = 100,000 + 4 × 50,000 + 6 × 28,500 + 100,000 × 1 = 571,000.
- Vault app MBR = 100,000 + 1 × 50,000 + 2 × 28,500 + 100,000 × 1 = 307,000.
- Factory app MBR = 100,000 + 4 × 50,000 + 2 × 28,500 = 357,000.
- Campaign app account: **0** (no boxes/assets; never funded).
- Vault app account: 100,000 base + 32,100 per live/failed campaign box. The
  deploy script funds it with 1 ALGO; after the 100,000 base that is ~28 boxes.
- Factory app account: 100,000 base + 18,900 per registration box. The deploy
  script funds it with 1 ALGO; each creator's 18,900 deposit covers that
  campaign's registration box.

The per-slot costs are the protocol's: a global **uint** is 25,000 + 3,500 =
28,500 µA and a global **byte slice** is 25,000 + 25,000 = 50,000 µA. An earlier
revision of this page used 25,000/3,500 for byte slices/uints and understated the
MBR; the values above were measured on LocalNet against the real schemas.

## Current per-campaign storage

| Item | Key | Value | MBR | Owner |
| --- | --- | --- | ---: | --- |
| Vault campaign box | `'c' + appId` (9 B) | `paidIn(8) ‖ paidOut(8) ‖ root(32) ‖ N(8) ‖ status(1) ‖ settledAt(8)` (65 B) | 32,100 µA | vault app account |
| Factory registration box | `'r' + appId` (9 B) | creator address (32 B) | 18,900 µA | Factory app account |

The vault box is opened by the first `credit` (first pledge) and released by
`notifyDelete` / `releaseClaimed` / `finalize`. The Factory box is opened by
`register` and released by `unregister`. The creator's registration deposit
covers the Factory box; the vault box is platform-funded and is not charged to
the creator or backer.

## Campaign duration cap

`Campaign.create` rejects a deadline more than 180 days after creation. A failed
campaign's vault box therefore stays live for at most the campaign duration plus
the 730-day refund window (~2.5 years), instead of being pinnable indefinitely by
a 1 µA pledge. This is a backstop, not a product limit: Kickstarter and Indiegogo
cap at 60 days, and 180 leaves room for extended raises.

## Minimum pledge

`Campaign.pledge` rejects payments below 0.1 ALGO (100,000 µA), about 3× the
vault box MBR and 100× the minimum transaction fee. The floor removes 1 µA dust
while keeping micro-pledges possible; the principal stays refundable.

## Supported tree size

`Campaign.pledge` rejects a campaign that already has **524,287** positions
(2¹⁹ − 1). This is the largest tree whose worst-case refund path fits the AVM's
16-inner-transaction limit: at `N = 2¹⁹ − 1`, leaf 0 has `r = c = 18`, which
needs 14 OpUp takes plus the campaign path's inner `payBack` and inner payment =
16 inner transactions, even with a zero-op prelude. A larger tree can have
`r = 19, c = 18`, whose 9,950-op target can request a 15th take. The cap counts
every position ever appended, including cancelled pledges, because positions
are never reused. Above it the contract rejects the pledge and the SDK fails
with a clear "maximum size" error.

## Current creator cost (create a campaign)

The create flow is `[create app call]` then `[deposit payment, register app call]`.

| Item | Amount | Spent or locked? |
| --- | ---: | --- |
| Campaign app MBR | 571,000 µA | locked on the creator's account; released on `delete` |
| Registration deposit | 18,900 µA | paid to the Factory; returned by `unregister` |
| Create app-call fee | 1,000 µA | spent |
| Deposit payment fee | 1,000 µA | spent |
| Register app-call fee | 1,000 µA | spent |
| **Total capital locked** | **589,900 µA (~0.59 ALGO)** | recoverable on `[unregister, delete]` |
| **Total fees spent** | **3,000 µA** | not recoverable |

The current campaign is 2 pages, so the creator locks **~0.59 ALGO**. The 1-page
target is **~0.49 ALGO**: 471,000 app MBR + 18,900 deposit = 489,900 µA. An extra
page adds 100,000 µA. The create flow does **not** fund the campaign app account
and does **not** pay the vault box MBR.

A create followed immediately by delete spends about 3,000 µA (create fees) +
5,000 µA (cleanup fees) = ~8,000 µA, and returns the 589,900 µA capital.

## Current transaction fees

The SDK sizes pledge and spend extras from the claim tree. The contract's
`ensureBudget` tops the group up in 700-op increments; each increment is one
inner app call and costs one extra minimum fee (1,000 µA). The contract and SDK
use the same tree-shape formulas (see [`claim-tree-protocol.md`](claim-tree-protocol.md) §14).

| Action | Transactions | SDK total | Notes |
| --- | --- | ---: | --- |
| Create + register | create + deposit + register | 5,000 µA | 3,000 µA measured on-chain; 2,000 µA headroom |
| Pledge | pay + `pledge` + `credit` + 0..6 OpUp takes | 4,000-10,000 µA | 4,000 base (includes the first-touch factory check headroom); +1,000 per OpUp take |
| Cancel / refund, campaign path | campaign + inner `payBack` + inner payment + 0..14 OpUp takes | 4,000-17,000 µA | +1,000 per OpUp take; 5,000 at N=4, 7,000 at N=100 |
| Refund, vault path | vault + inner payment + 0..14 OpUp takes | 3,000-16,000 µA | one payout inner; +1,000 per OpUp take |
| Claim | campaign + inner `payClaim` + inner payment | 3,000 µA | fixed; no tree-dependent budget |
| `[unregister, delete]` | unregister + inner deposit + delete + inner settle/notify + escrow close | 5,000 µA | fixed |
| `settleOpen` | vault only | 1,000 µA | not exposed in the SDK/CLI yet |
| `finalize` | vault + inner payment (if residual) | 2,000 µA | 1,000 µA without residual; not exposed yet |
| `releaseClaimed` | vault only | 1,000 µA | not exposed yet |
| `Factory.register` | deposit + register | 2,000 µA | inside the create flow |
| `Factory.unregister` | unregister + inner deposit | 2,000 µA | inside cleanup |

OpUp sizing: one `ensureBudget` iteration submits **one** inner app call
(the Puya OpUp create-and-delete program), costing 1,000 µA and adding ~700
ops. The campaign request is `240 × popcount(N) + 400`; a spend request is
`250 × (siblings + lower peaks) + 100 × top + 700`. The SDK mirrors those
formulas with assumed pre-top-up budgets (1,000 for pledge, 500 for a spend);
the measured spend prelude is larger than that assumption on long paths, so
the take count must be sized from the real remaining budget (see
[`claim-tree-protocol.md`](claim-tree-protocol.md) §14).

## Current platform cost (deploy)

| Item | Amount | Notes |
| --- | ---: | --- |
| Factory app MBR | 357,000 µA | locked on the deployer's account |
| Factory app-account funding | 1,000,000 µA | base + registration headroom |
| Vault app MBR | 307,000 µA | locked on the deployer's account |
| Vault app-account funding | 1,000,000 µA | base + ~28 campaign boxes |
| Deploy fees | ~9,000 µA | Factory create/fund/hash + vault create/fund/vault-hash/bind |

The vault's 1 ALGO funding is a platform liability: each live/failed campaign
box parks 32,100 µA until `notifyDelete` / `releaseClaimed` / `finalize`. Monitor
it and top it up as the number of live/failed campaigns grows.

## Rules for contract changes

1. **Measure before and after.** Run `npm run build` in `projects/contracts`,
   record the approval/clear bytecode sizes, page count, app MBR, box MBR, and
   every affected group's fee. Update this page and the affected docs in the
   same change set.
2. **Do not silently change the creator cost.** The campaign create cost is a
   product promise. A change that adds an extra page (+100,000 µA), adds a
   global slot (+50,000 µA for a byte slice, +28,500 µA for a uint), adds a box,
   or adds an inner txn to create/register must be called out in the commit/PR
   and explicitly approved. The current cost is ~0.59 ALGO; the 1-page target is
   ~0.49 ALGO. The frontend must disclose the current locked amount at create and
   next to Delete (see [`frontend.md`](frontend.md)).
3. **Any campaign program change changes the Factory `approvalHash`.** Update
   the deploy script, tests, docs, specs/SDK release, and the deployed Factory
   hash (or redeploy Factory + vault). The current formula is
   `sha256(itob(approval.length) ‖ approval ‖ clear)`; the length prefix binds the
   approval/clear split. A new Factory sets its first hash immediately; an
   existing Factory must propose, wait `APPROVAL_HASH_DELAY` (~7 days), then
   apply. The vault program hash is verified once at `setVault`.
4. **Distinguish locked from spent.** App/box MBR and the registration deposit
   are locked and recoverable; transaction fees are spent. Do not describe the
   total locked amount as a fee.
5. **Keep the vault and Factory funded.** New boxes increase their accounts'
   minimum balances. The vault box is platform-funded; the Factory box is
   covered by the creator deposit.
6. **Respect the no-surcharge page limit.** The current limit is 3 extra pages
   (8,192 B total). Do not rely on the 7-extra-page surcharge path unless the
   target network supports it and the cost is accepted.
7. **Respect the group/resource limits.** A new inner txn, box reference, app
   reference, or account reference can push a group over the 8-reference / 16-
   inner-txn limits. Check the group shape and fee pooling.

### Measure the current sizes

```bash
cd projects/contracts
npm run build
node -e "
const fs = require('fs');
for (const n of ['campaign/Campaign', 'claimsvault/ClaimsVault', 'factory/Factory']) {
  const s = JSON.parse(fs.readFileSync('smart_contracts/artifacts/' + n + '.arc56.json', 'utf8'));
  const a = Buffer.from(s.byteCode.approval, 'base64').length;
  const c = Buffer.from(s.byteCode.clear, 'base64').length;
  const extra = Math.floor((a + c - 1) / 2048);
  console.log(n, { approval: a, clear: c, total: a + c, extraPages: extra, capacity: 2048 * (1 + extra), headroom: 2048 * (1 + extra) - (a + c) });
}
"
```

App MBR is derived from the global schema and page count, not the bytecode
length. Confirm it against a real LocalNet account when changing a schema:

```bash
node -e "
const fs = require('fs');
for (const n of ['campaign/Campaign', 'claimsvault/ClaimsVault', 'factory/Factory']) {
  const s = JSON.parse(fs.readFileSync('smart_contracts/artifacts/' + n + '.arc56.json', 'utf8'));
  const { ints, bytes } = s.state.schema.global;
  const total = Buffer.from(s.byteCode.approval, 'base64').length + Buffer.from(s.byteCode.clear, 'base64').length;
  const extra = Math.floor((total - 1) / 2048);
  console.log(n, { ints, bytes, extraPages: extra, appMbr: 100000 + ints * 28500 + bytes * 50000 + extra * 100000 });
}
"
```

## See also

- [`campaign.md`](campaign.md) - Campaign methods, state, and the per-call fee table
- [`claim-tree-protocol.md`](claim-tree-protocol.md) - tree math, opcode budget, and resource analysis
- [`architecture.md`](architecture.md) - pieces, deployment, and settlement flows
- [`frontend.md`](frontend.md) - user-facing fee disclaimers
- [the KasaKame project](https://github.com/orgs/kasakame/projects/1) - open hardening and release items
