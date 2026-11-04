# Limits, sizes, storage, and fees

Single source of truth for the AVM/Algorand limits and the current cost of the
kasakame contracts. Read this before changing any contract code; update it in the
same change set when a size, storage, group shape, or fee changes.

The current numbers are the compiled bytecode from `npm run build` on 2026-11-04,
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
| Larger-transaction fee | +1,000 µA per 1,000 B | a 2,267 B create txn needs 3,000 µA; inner txn fees are paid from the group fee pool |
| Account base MBR | 100,000 µA | app accounts with boxes must hold this; the campaign app account holds 0 |
| App creation MBR | 100,000 + 25,000 × global bytes + 3,500 × global uints + 100,000 × extra pages | charged to the creator |
| App opt-in MBR | 100,000 + 25,000 × local bytes + 3,500 × local uints | charged to the opted-in account; not used |
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
| Campaign | 2,065 B | 4 B | 2,069 B | 1 (2 pages) | 4,096 B | 2,027 B |
| ClaimsVault | 2,755 B | 4 B | 2,759 B | 1 (2 pages) | 4,096 B | 1,337 B |
| Factory | 687 B | 4 B | 691 B | 0 (1 page) | 2,048 B | 1,357 B |

The campaign is **21 bytes over** the 1-page (2,048 B) limit. It is already a
2-page app; the next page boundary is 4,096 B. Trimming 21 B would return it to
one page and save 100,000 µA of creator MBR.

## Current app MBR and storage

| Contract | Global schema | Extra pages | App MBR | Who pays | Local state |
| --- | --- | ---: | ---: | --- | --- |
| Campaign | 4 byte-slices + 6 uints | 1 | **571,000 µA** | creator's account | none |
| ClaimsVault | 1 byte-slice + 2 uints | 1 | **307,000 µA** | platform/deployer | none |
| Factory | 2 byte-slices + 1 uint | 0 | **228,500 µA** | platform/deployer | none |

- Campaign app MBR = 100,000 + 4 × 50,000 + 6 × 28,500 + 100,000 × 1 = 571,000.
- Vault app MBR = 100,000 + 1 × 50,000 + 2 × 28,500 + 100,000 × 1 = 307,000.
- Factory app MBR = 100,000 + 2 × 50,000 + 1 × 28,500 = 228,500.
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

## Current creator cost (create a campaign)

The create flow is `[create app call]` then `[deposit payment, register app call]`.

| Item | Amount | Spent or locked? |
| --- | ---: | --- |
| Campaign app MBR | 571,000 µA | locked on the creator's account; released on `delete` |
| Registration deposit | 18,900 µA | paid to the Factory; returned by `unregister` |
| Create app-call fee | 3,000 µA | spent (2,267 B txn) |
| Deposit payment fee | 1,000 µA | spent |
| Register app-call fee | 1,000 µA | spent |
| **Total capital locked** | **589,900 µA (~0.59 ALGO)** | recoverable on `[unregister, delete]` |
| **Total fees spent** | **5,000 µA** | not recoverable |

The current campaign is 2 pages, so the creator locks **~0.59 ALGO**. The 1-page
target is **~0.49 ALGO**: 471,000 app MBR + 18,900 deposit = 489,900 µA. An extra
page adds 100,000 µA. The create flow does **not** fund the campaign app account
and does **not** pay the vault box MBR.

A create followed immediately by delete spends about 5,000 µA (create fees) +
5,000 µA (cleanup fees) = ~10,000 µA, and returns the 589,900 µA capital.

## Current transaction fees

The SDK uses fixed extra fees; the "minimum" column is the smallest fee that can
work for a small tree (no OpUp). The fixed extra is paid even when an OpUp is not
needed, so the SDK overpays on small campaigns.

| Action | Transactions | SDK total | Minimum (small tree) | Notes |
| --- | --- | ---: | ---: | --- |
| Create + register | create + deposit + register | 5,000 µA | 5,000 µA | create txn is 2,267 B → 3,000 µA |
| Pledge (first touch) | pay + pledge + credit + inner `isRegistered` | 4,000 µA | 4,000 µA | first pledge opens the vault box |
| Pledge (later) | pay + pledge + credit | 4,000 µA | 3,000 µA | SDK still pays the 1,000 µA extra |
| Cancel / refund, campaign path | campaign + inner `payBack` + OpUp | 4,000 µA | 2,000 µA | `FEE_SPEND_EXTRA = 3,000` |
| Refund, vault path | vault + OpUp | 4,000 µA | 1,000 µA | `FEE_SPEND_EXTRA = 3,000` |
| Claim | campaign + inner `payClaim` + inner payment | 3,000 µA | 3,000 µA | `FEE_CLAIM_EXTRA = 2,000` |
| `[unregister, delete]` | unregister + inner deposit + delete + inner settle/notify + escrow close | 5,000 µA | 5,000 µA | `FEE_UNREGISTER_EXTRA = 1,000`, `FEE_DELETE_EXTRA = 2,000` |
| `settleOpen` | vault only | 1,000 µA | 1,000 µA | not exposed in the SDK/CLI yet |
| `finalize` | vault + inner payment (if residual) | 2,000 µA | 1,000 µA | not exposed in the SDK/CLI yet |
| `releaseClaimed` | vault only | 1,000 µA | 1,000 µA | not exposed in the SDK/CLI yet |
| `Factory.register` | deposit + register | 2,000 µA | 2,000 µA | inside the create flow |
| `Factory.unregister` | unregister + inner deposit | 2,000 µA | 2,000 µA | inside cleanup |

OpUp sizing: each `ensureBudget` iteration submits a create + delete inner pair,
costing ~2,000 µA and adding ~700 ops. The campaign/refund paths size for it;
the SDK's fixed extras cover one iteration. Large trees may need more. See
[`claim-tree-protocol.md`](claim-tree-protocol.md) §14.

## Current platform cost (deploy)

| Item | Amount | Notes |
| --- | ---: | --- |
| Factory app MBR | 228,500 µA | locked on the deployer's account |
| Factory app-account funding | 1,000,000 µA | base + registration headroom |
| Vault app MBR | 307,000 µA | locked on the deployer's account |
| Vault app-account funding | 1,000,000 µA | base + ~28 campaign boxes |
| Deploy fees | ~8,000 µA | Factory create/fund/hash + vault create/fund/bind |

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
   approval/clear split.
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
- [`roadmap.md`](roadmap.md) - open hardening and release items
