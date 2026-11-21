# Limits, sizes, storage, and fees

Single source of truth for the AVM/Algorand limits and the current cost of the
kasakame contracts. Read this before changing any contract code; update it in the
same change set when a size, storage, group shape, or fee changes.

The current numbers are the compiled bytecode from `npm run build` on 2026-11-20,
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
| Inner transactions | 16 per app call, 256 per group | `MaxInnerTransactions` × group size; the worst-case refund uses 16 |
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

## Product input bounds

The contracts enforce these product bounds at the method boundary. They were
decided in [#207](https://github.com/kasakame/kasakame/issues/207) and are
enforced in [#235](https://github.com/kasakame/kasakame/issues/235). The AVM
protocol limits above stay separate: oversized args, boxes, groups, and opcode
budgets fail at the protocol layer.

| Input | Bound | Enforced by |
| --- | --- | --- |
| Title | 1 to 123 bytes | `Campaign.create` |
| Metadata URI | 0 to 117 bytes | `Campaign.create` |
| Goal | 100,000 µA (0.1 ALGO) to 10¹⁶ µA (total supply) | `Campaign.create` |
| Deadline | 1 day to 180 days after creation | `Campaign.create` |
| Pledge | 100,000 µA to 10¹⁶ µA | `Campaign.pledge` |
| `raised` | Explicit uint64 overflow guard; no product cumulative cap | `Campaign.pledge` |
| `paidIn` | Explicit uint64 overflow guard; no product cumulative cap | `Vault.credit` |
| Refund window | 30 days to 10 years | `Vault.create`, `Registry.create` |
| Registration deposit | Exactly 18,900 µA | `Registry.register` |
| Campaign status | `0/1/2` only where the Registry or vault reads it | `Registry.unregister`, `Vault.settleOpen` |
| Vault `n` | At most 524,287 in `settle` and `settleOpen` | `Vault.settle`, `Vault.settleOpen` |

A product cumulative-flow cap is deliberately not added: a lifetime cap would
be cheaper for a funded attacker to reach than the uint64 guard. The residual
griefing class is the one accepted in #208.

## Current compiled footprint

Measured from `smart_contracts/artifacts/*/*.arc56.json` (`byteCode.approval` +
`byteCode.clear`).

| Contract | Approval | Clear | Total | Extra pages | Page capacity | Headroom to next page |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Campaign | 2,246 B | 4 B | 2,250 B | 1 (2 pages) | 4,096 B | 1,846 B |
| ClaimsVault | 2,866 B | 4 B | 2,870 B | 1 (2 pages) | 4,096 B | 1,226 B |
| Registry | 961 B | 4 B | 965 B | 0 (1 page) | 2,048 B | 1,083 B |

The campaign is **202 bytes over** the 1-page (2,048 B) limit. It is already a
2-page app; the next page boundary is 4,096 B. Trimming 202 B would return it to
one page and save 100,000 µA of creator MBR.

`npm run test:size` pins these values in
`test/utils/contract-sizes.ts` and runs in the `compile-contracts` CI
job after `npm run build`. A byte, page, or schema change must update the snapshot
and this table together.

## Current app MBR and storage

| Contract | Global schema | Extra pages | App MBR | Who pays | Local state |
| --- | --- | ---: | ---: | --- | --- |
| Campaign | 4 byte-slices + 6 uints | 1 | **571,000 µA** | creator's account | none |
| ClaimsVault | 1 byte-slice + 2 uints | 1 | **307,000 µA** | platform/deployer | none |
| Registry | 3 byte-slices + 2 uints | 0 | **307,000 µA** | platform/deployer | none |

- Campaign app MBR = 100,000 + 4 × 50,000 + 6 × 28,500 + 100,000 × 1 = 571,000.
- Vault app MBR = 100,000 + 1 × 50,000 + 2 × 28,500 + 100,000 × 1 = 307,000.
- Registry app MBR = 100,000 + 3 × 50,000 + 2 × 28,500 = 307,000.
- Campaign app account: **0** (no boxes/assets; never funded).
- Vault app account: 100,000 base + 32,100 per live/failed campaign box. The
  deploy script funds it with 1 ALGO; after the 100,000 base that is ~28 boxes.
- Registry app account: 100,000 base + 18,900 per registration box. The deploy
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
| Registry registration box | `'r' + appId` (9 B) | creator address (32 B) | 18,900 µA | Registry app account |

The vault box is opened by the first `credit` (first pledge) and released by
`notifyDelete` / `releaseClaimed` / `finalize`. The Registry box is opened by
`register` and released by `unregister`. The creator's registration deposit
covers the Registry box; the vault box is platform-funded and is not charged to
the creator or backer.

## Campaign duration bounds

`Campaign.create` rejects a deadline less than 24 hours or more than 180 days
after creation.

The one-day minimum gives backers a review and pledge window and blocks flash
campaigns that exist only to settle and delete. It is a UX guard, not a fix for
the vault-box pinning path: an attacker can wait out the day, pledge the minimum,
settle, and leave the platform-funded 32,100 µA box for the 730-day refund
window. The refund window is the lever for that case.

The 180-day maximum bounds how long a failed campaign's vault box can stay live:
campaign duration plus the 730-day refund window (~2.5 years), instead of being
pinnable indefinitely by a 1 µA pledge. It is a backstop, not a product limit:
Kickstarter and Indiegogo cap at 60 days, and 180 leaves room for extended raises.

## Goal bounds

`Campaign.create` rejects a goal below **0.1 ALGO** (100,000 µA) or above
**10,000,000,000 ALGO** (10¹⁶ µA), the total ALGO supply. A goal below the
minimum pledge can only be met by overfunding with the smallest pledge, and a
goal above the total supply can never be reached. Both are UX guards, not
resource guards: the goal is stored in a uint64, and the total supply stays far
below the uint64 maximum.

## Title and metadata URI caps

The AVM caps a global-state entry at 128 bytes including the key. `title` is a
5-byte key, so its value is capped at 123 bytes. `metadataUri` is an 11-byte key,
so its value is capped at 117 bytes. `Campaign.create` rejects longer values
before the state write.

## Pledge bounds

`Campaign.pledge` rejects payments below 0.1 ALGO (100,000 µA), about 3× the
vault box MBR and 100× the minimum transaction fee. The floor removes 1 µA dust
while keeping micro-pledges possible; the principal stays refundable. It also
rejects a single pledge above 10¹⁶ µA (the total ALGO supply), and asserts that
`raised` and the vault's `paidIn` cannot overflow uint64. There is no product
cumulative-flow cap; the overflow guard is the safety bound.

## Supported tree size

`Campaign.pledge` rejects a campaign that already has **524,287** positions
(2¹⁹ − 1). At that size leaf 0 has `r = c = 18` (36 path elements), whose hashing
needs 14 OpUp takes. The ABI router and guards consume the first part of the 700
base opcodes, so 14 takes + the campaign path's `payBack` + payment = 16 inner
transactions, the per-transaction limit. The SDK's zero-headroom fee bound funds
**15** takes, so a group is never underpaid; the contract simply never requests
the 15th. The `06` ladder's N=1,023 rung (h=18, 7 takes) proves the prelude
leaves enough base ops for the cap's ~262. If a contract change ever pushes the
prelude past that guard, the rung fails before the cap breaks. The cap counts every position
ever appended, including cancelled pledges, because positions are never reused.
Above it the contract rejects the pledge and the SDK fails with a clear
"maximum size" error. The separate `heavy-tests` workflow fills the full 2¹⁹ − 1
tree on LocalNet for both outcomes: `99-cap-failed` settles and deletes early
through the cap-saturation escape and pins the worst-case vault refund;
`99-cap-claimed` pins the claim path and the rejected early settlement. The
offline cap test pins the 14 takes and the 18,000 µA worst-case campaign group
fee.

**Cap saturation:** once the tree is full, a campaign with `raised < goal` can
never succeed. `Vault.settleOpen` settles it before the deadline, and
`Campaign.delete` plus `Registry.unregister` treat `n == MAX_TREE_SIZE &&
raised < goal` as failed-in-fact, so the creator recovers the app MBR and
backers refund immediately. This is the #229 harm-reduction escape; it does not
change the attacker's cost or prevent the fill.

### AVM shapes the contracts depend on

| Shape | Maximum | Where |
| --- | ---: | --- |
| Frontier peaks | 19 peaks / 608 B | `Campaign.pledge` app arg at `N` with all 19 bits set |
| Proof path | 36 elements / 1,152 B | `cancelPledge`/`refund` at `r = c = 18` (32-byte siblings) |
| App args per call | 2,048 B total | protocol `MaxAppTotalArgLen`; the largest contract arg is 1,154 B (a 1,152-byte path plus its ABI length prefix) |
| Inner transactions | 16 per app call | worst-case campaign refund: 14 OpUp takes + `payBack` + payment |
| Opcode budget | 700 per app call | `MaxAppProgramCost`; the group buys extra 700-op blocks through OpUp |

## Current creator cost (create a campaign)

The create flow is `[create app call]` then `[deposit payment, register app call]`.

| Item | Amount | Spent or locked? |
| --- | ---: | --- |
| Campaign app MBR | 571,000 µA | locked on the creator's account; released on `delete` |
| Registration deposit | 18,900 µA | paid to the Registry; returned by `unregister` |
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
| Pledge | pay + `pledge` + `credit` + 0..6 OpUp takes | 4,000-10,000 µA | 4,000 base (includes the first-touch Registry check headroom); +1,000 per OpUp take |
| Cancel / refund, campaign path | campaign + inner `payBack` + inner payment + 0..14 actual OpUp takes (15 funded) | 5,000-18,000 µA | +1,000 per funded take; 5,000 at N=4, 8,000 at N=100 |
| Refund, vault path | vault + inner payment + 0..14 actual OpUp takes (15 funded) | 4,000-17,000 µA | one payout inner; +1,000 per funded take |
| Claim | campaign + inner `payClaim` + inner payment | 3,000 µA | fixed; no tree-dependent budget |
| `[unregister, delete]` | unregister + inner deposit + delete + inner settle/notify + escrow close | 5,000 µA | fixed |
| `settleOpen` | vault only | 1,000 µA | not exposed in the SDK/CLI yet |
| `finalize` | vault + inner payment (if residual) | 2,000 µA | 1,000 µA without residual; not exposed yet |
| `releaseClaimed` | vault only | 1,000 µA | not exposed yet |
| `Registry.register` | deposit + register | 2,000 µA | inside the create flow |
| `Registry.unregister` | unregister + inner deposit | 2,000 µA | inside cleanup |

OpUp sizing: one `ensureBudget` iteration submits **one** inner app call
(the Puya OpUp create-and-delete program), costing 1,000 µA and adding ~700
ops, of which the top-up loop itself spends ~25. The campaign request is
`240 × popcount(N) + 400`; a spend request is `250 × path elements + 700`,
sized from the caller-supplied path blob *before* `pathLen`/`popcount` run. The
ABI router and guards consume ~100 of the 700 base opcodes, leaving ~600 for
the proof; the N=1,023 ladder rung pins that headroom. The SDK mirrors the
formulas with assumed pre-top-up budgets (1,000 for pledge, zero for a spend)
and a 670-op net per spend take, so it may fund one more take than the contract
requests but never underfunds. See
[`claim-tree-protocol.md`](claim-tree-protocol.md) §14.

## Current platform cost (deploy)

| Item | Amount | Notes |
| --- | ---: | --- |
| Registry app MBR | 307,000 µA | locked on the deployer's account |
| Registry app-account funding | 1,000,000 µA | base + registration headroom |
| Vault app MBR | 307,000 µA | locked on the deployer's account |
| Vault app-account funding | 1,000,000 µA | base + ~28 campaign boxes |
| Deploy fees | ~5,000 µA | Registry create/fund + vault create/fund/bind |

The vault's 1 ALGO funding is a platform liability: each live/failed campaign
box parks 32,100 µA until `notifyDelete` / `releaseClaimed` / `finalize`. Monitor
it and top it up as the number of live/failed campaigns grows.

## Sweep target

`Vault.finalize` pays a failed campaign's residual to the vault's `sweepTarget`,
fixed at `Vault.create`. `Vault.create` rejects a zero target, the vault's own
address, and the Registry's address; `Registry.create` rejects its own address
as the configured target. The deploy script passes the same target to both. A
residual sent to the ownerless Registry would be stranded because the Registry
has no method that pays out its balance (it only returns registration deposits
through `unregister`).

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
3. **Any campaign program change changes the Registry `campaignProgramHash`.**
   Update the deploy script, tests, docs, specs/SDK release, and deploy a new
   Registry + Vault bundle. The current formula is
   `sha256(itob(approval.length) ‖ approval ‖ clear)`; the length prefix binds the
   approval/clear split. The Campaign hash, Vault hash, sweep target, and refund
   window are all fixed at Registry `create`; there is no in-place update or
   timelock. Old campaigns stay on the old bundle.
4. **Distinguish locked from spent.** App/box MBR and the registration deposit
   are locked and recoverable; transaction fees are spent. Do not describe the
   total locked amount as a fee.
5. **Keep the vault and Registry funded.** New boxes increase their accounts'
   minimum balances. The vault box is platform-funded; the Registry box is
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
for (const n of ['campaign/Campaign', 'claimsvault/ClaimsVault', 'registry/Registry']) {
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
for (const n of ['campaign/Campaign', 'claimsvault/ClaimsVault', 'registry/Registry']) {
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
