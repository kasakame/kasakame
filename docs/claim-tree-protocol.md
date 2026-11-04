# kasakame Claim Tree Protocol - Specification

> This document defines the claim tree: a trustless **incremental
> frontier-Merkle claim tree with in-place null-deletion**. The contracts, the offline and LocalNet test suites, and the frontend proof
> builder follow it. The language-independent reference model with property tests lives in
> [`claim-tree-protocol-reference.py`](claim-tree-protocol-reference.py) and serves as the oracle for the contract test suite
> (driven via `smart_contracts/oracle.py`).

## 1. Repository and protocol verification

AVM facts below were verified against go-algorand `master` (`data/transactions/logic/opcodes.go`,
`TEAL_opcodes_v12.md`, `config/consensus.go`, `ledger/apply/application.go`, `ledger/apply/asset.go`, `basics/userBalance.go`).

### Architecture (as implemented)

- **Campaign** (`smart_contracts/campaign/contract.algo.ts`) - one stateful app per campaign. Global state: `creator`, `vault`, `title`,
  `metadataUri`, `goal`, `deadline`, `raised`, `status`, `root`, `n`. Methods: `create`, `pledge`, `cancelPledge`, `refund`,
  `claim`, `delete`. The escrow is never funded and holds nothing; backers' ALGO goes to the vault; each pledge appends one leaf;
  `delete()` is O(1) on every path.
- **ClaimsVault** (`smart_contracts/claimsvault/contract.algo.ts`) - permanent pooled escrow. State: one 65-byte box per campaign
  (`paidIn`, `paidOut`, `root`, `N`, `status`, `settledAt`). Methods: `credit`, `payBack`, `payClaim`, `settle`, `settleOpen`,
  `refund`, `notifyDelete`, `releaseClaimed`, `finalize`. Payout amounts are per-campaign capped by verified inflows
  (`amount <= paidIn - paidOut`); inner payouts are gated on the campaign app caller; vault refunds work after campaign deletion.
- **Factory** (`smart_contracts/factory/contract.algo.ts`) - registration registry only: `owner`, `approvalHash` (SHA-256
  over the approval + clear-state programs), `pendingApprovalHash`/`approvalHashEligibleAt` (the ~7-day timelock for a changed
  campaign hash), `vault`, `vaultApprovalHash`, `registered` BoxMap; `register` verifies the campaign program hash, the
  campaign's `vault` global (the owner-bound official vault), and the creator identity; refundable 18,900 µA deposit. The owner
  can transfer or renounce ownership; `setVault` verifies the vault's approval + clear-state hash and is one-time.
  **Governance:** the first campaign hash is immediate; later changes are proposed and applied after `APPROVAL_HASH_DELAY`
  (~7 days). Old registrations stay valid and only future registrations use the new hash. No owner action can pause, delete,
  seize, or unregister an existing campaign; renouncing freezes configuration. See
  [`architecture.md`](architecture.md#factory-governance-and-revocation).
- **Transaction groups:** pledge `[Payment→vault, Campaign.pledge, Vault.credit]` (payment immediately before the pledge,
  credit immediately after it and final; the vault requires the pledge before the credit); cleanup
  `[Factory.unregister, Campaign.delete]` (the Factory requires the delete immediately after; the campaign requires the
  unregister immediately before when its vault has a Factory binding); cancel/refund carry one leaf proof each; claim is a
  single app call with an inner vault call. Every paired call must be a `NoOp` app call: `ClearState` runs the clear-state
  program instead of the method, so it can satisfy a selector check without executing the paired logic.
- **MBR (current):** creator ≈ 0.59 ALGO (2-page app + schema + 1 extra page + registration, recoverable O(1) via the atomic
  `[unregister, delete]` group; the 1-page target is ≈ 0.49 ALGO - see [`limits.md`](limits.md));
  vault 32,100 µA per live or failed campaign box, recovered via `notifyDelete`/`releaseClaimed`/`finalize`; backer 0 (no
  opt-ins exist).

### AVM facts relied on (verified)

| Fact | Value | Source |
| --- | --- | --- |
| `sha512_256` opcode | SHA-512/256, cost 35 | `opcodes.go` v2+ |
| Per-call opcode budget | 700, never raised | `consensus.go` v24 |
| Group budget pooling | 700 per app call in the group; inner app calls add 700 each to the shared pool | `consensus.go` v30 (`EnableAppCostPooling`); `eval.go` `NewAppEvalParams`/`NewInnerEvalParams` |
| `txn TxID` / `gtxn i TxID` | `[32]byte`, available without version gate (field 23) | `TEAL_opcodes_v12.md` |
| App args | 16 max; **2048 bytes total**; absolute 16,384 with a fee surcharge | `consensus.go` (`MaxAppTotalArgLen` = 2048, v24); [`limits.md`](limits.md) |
| Program size | 2,048 B combined approval + clear base; +2,048 B per extra page; 3 extra pages without surcharge (up to 7 with a fee surcharge on newer consensus) | `MaxAppTotalProgramLen`, `MaxExtraAppProgramPages`; [`limits.md`](limits.md) |
| Inner transactions | 16 per app call; 256 per group | `MaxInnerTransactions`; [`limits.md`](limits.md) |
| Box | 2,500 + 400×(name+value) µA MBR; name ≤ 64 B, value ≤ 32 KB; 8 refs/call; 2,048 B IO budget per ref | docs, `consensus.go` v36, repo constants |
| App opt-in (local state) MBR | 100,000 + 25,000/byte-slice + 3,500/uint, on the **opted-in account**; app deletion does **not** release it | `userBalance.go`, `deleteApplication` |
| No history access | `block` = header fields only; no opcode reads past transactions or logs; no state-proof verification | `opcodes.go` |

## 2. Formal protocol definition

### Hash function

`H(x) = SHA-512/256(x)` - the AVM `sha512_256` opcode (not `sha256`, which is plain SHA-256). `Z = 0x00 × 32` (32 zero bytes).

### Leaf

```text
leaf = H( 0x01 ‖ backer ‖ amount ‖ paymentTxId )
      backer      : 32 bytes - the pledger's account address (contract-derived: Txn.sender)
      amount      :  8 bytes - big-endian uint64 (contract-derived: payment.amount)
      paymentTxId : 32 bytes - the pledge payment's transaction ID (contract-derived: payment.txnId)
```

**Domain separation:** every other `H` application in the protocol combines two 32-byte node values (64-byte preimages)
or a peak fold (also 64-byte preimages). The 73-byte `0x01`-prefixed leaf preimage shares no length-prefix ambiguity with any of them,
so no adversary can mix leaf hashes into internal-node positions or vice versa. The single byte suffices: no two legitimate preimage
forms collide in length.

**Contract derivation, not caller copies:** the leaf is computed by the contract from the transaction itself - `Txn.sender` is the app
call sender, `payment.amount` and `payment.txnId` are read from the pledged payment in the same atomic group (the ABI argument is a
`gtxn.PaymentTxn` reference; `txn TxID` is readable in AVM - verified above). The caller never supplies the leaf or any of its
components at pledge time. `assert leaf ≠ Z` at append.

## 3. Canonical tree definition

The tree is a **left-filled binary Merkle tree over N positions**, where `N` = number of positions ever appended and is **never
decremented**.

- **Positions:** `0 … N−1`; position `i` holds a *leaf value* `v_i`, which is either a leaf (§2) or the consumed marker `Z`.
- **Nodes:** node `(l, i)` covers the aligned block `[i·2ˡ, (i+1)·2ˡ)` and exists iff `(i+1)·2ˡ ≤ N` (blocks are never partial - the
  rightmost partial blocks are represented by peaks, below). Leaf level: `(0, i) = v_i`. Internal: `(l, i) = H( (l−1, 2i) ‖ (l−1, 2i+1) )`.
- **Tree shape:** uniquely determined by `N` alone.
- **Peaks (frontier):** `N = Σ 2ˡ` over set bits. For every set bit `l` of `N` there is exactly one peak `f_l` at level `l`: the subtree
  root of the block `[((N>>l)−1)·2ˡ, ((N>>l)−1)·2ˡ + 2ˡ)` - i.e., the perfect subtree ending at position `N`. `f_0` is the newest
  trailing element; higher peaks are older, larger subtrees. Peak count `p = popcount(N)`.
- **Peak ordering:** ascending by level, `[f₀, f₁, …]`.
- **Fold (the single stored root):**

```text
fold([f₀ … f_{p−1}])  =  acc := f_{p−1};  for j = p−2 … 0:  acc := H(acc ‖ f_j)
```

The highest peak is always the left argument of every combine - this is what makes `fold` equal the natural root of the left-filled
tree. **Empty tree:** `Root(∅) = Z`, asserted while `N = 0`.

**Symbolic roots** (`l_i` = leaf value at position `i`):

| N | Root |
| --- | --- |
| 0 | `Z` |
| 1 | `l₀` |
| 2 | `H(l₀‖l₁)` |
| 3 | `H(H(l₀‖l₁)‖l₂)` |
| 4 | `H(H(l₀‖l₁)‖H(l₂‖l₃))` |
| 5 | `H(H(H(l₀‖l₁)‖H(l₂‖l₃))‖l₄)` |
| 6 | `H(H(H(l₀‖l₁)‖H(l₂‖l₃))‖H(l₄‖l₅))` |
| 7 | `H(H(H(l₀‖l₁)‖H(l₂‖l₃))‖H(H(l₄‖l₅)‖l₆))` |
| 8 | `H(H(H(l₀‖l₁)‖H(l₂‖l₃))‖H(H(l₄‖l₅)‖H(l₆‖l₇)))` |

All formulas in this document were validated symbolically and exhaustively (every N ≤ 12, every leaf pattern) by the reference model.

## 4. Frontier authentication and append

`pledge()` receives the frontier **from the caller** as a single byte string: the peak values in ascending level order, exactly
`p = popcount(N)` values, `32·p` bytes (length asserted against the contract's stored `N`).

1. **Payment checks** (see §9) - the payment is verified atomically in-group.
2. **Frontier authentication:** the contract computes `fold(frontier)` using the peak levels dictated by its **own stored `N`** and
   asserts equality with the **stored root**. Under SHA-512/256 collision resistance, the fold function has no computable alternative
   preimage: a different history would produce different peak values, and no two distinct peak tuples fold to the same root. The
   verified frontier is therefore *the* frontier of the committed tree.
3. **Merge cascade:** `g := leaf; l := 0; while bit l of N is set: g := H(f_l ‖ g); l += 1`. The consumed (older) peak is always the
   **left** child; the incoming node is the right child.
4. **Surviving peaks:** the peaks at levels `> l` survive unchanged; `g` becomes the new peak at level `l`.
5. **New root:** `fold([g] ‖ surviving peaks)`; `N' = N + 1`. Store `(root′, N′)`.

**Induction proof.** Invariant: `storedRoot = Root(v₀ … v_{N−1})` (the canonical root over the current leaf values).
*Base:* `N = 0, root = Z` ✓. *Step (append):* by hypothesis the stored root commits `v₀ … v_{N−1}`; the authenticated frontier is that
tree's peaks; the cascade is exactly the MMR append (`H(old-peak ‖ new)` preserves the left/right convention of §3), so
`fold(new peaks)` is by construction the canonical root over `v₀ … v_{N−1}, v_N` - verified exhaustively and by random testing against
naive tree construction. *Step (null):* §5. ∎

## 5. Nullification (refund)

The refund proof carries `(k, amount, paymentTxId, path)`. The contract:

1. Recomputes `leaf_k = H(0x01 ‖ Txn.sender ‖ amount ‖ paymentTxId)` - **derived from the caller and the proof**, never trusted.
2. Reconstructs the root from `leaf_k` along the path (§6) and asserts it equals the stored root.
3. Recomputes the root with `Z` in place of `leaf_k` and stores it; pays `amount`; `refundedTotal += amount`.

**Path structure** (derived by the contract from `(N, k)`): for `l = 0, 1, …` while the sibling node `(l, (k>>l)⊕1)` exists - i.e.
while `(((k>>l)⊕1)+1)·2ˡ ≤ N` - the sibling value appears in the path (ascending `l`). Let `r` be the first level where the sibling
does not exist; the node containing `k` at level `r` is the peak `f_r` (this is a property of the left-filled shape - validated
exhaustively). The path continues with: `top` - the **fold of all peaks at levels > r** (one 32-byte value; omitted when none exist) -
followed by the peaks at levels `< r` in ascending order (`c = popcount(N mod 2ʳ)` values). The expected path length
`r + c + e (e ∈ {0,1})` is asserted by the contract.

**Combine rule:** for the first `r` values, direction is bit `l` of `k` (`0` → `H(current ‖ sibling)`, `1` → `H(sibling ‖ current)`);
then `acc := H(top ‖ acc)` if `top` exists; then for each lower peak in **descending** order: `acc := H(acc ‖ peak)`.

### Proofs A–G

- **A. Validity.** `Root(v₀ … Z … v_{N−1})` is well-defined: `Z` is a leaf value; the combine recomputation over the unchanged
  siblings reproduces exactly the canonical root with `v_k := Z`. Verified symbolically and exhaustively (§15).
- **B. Append compatibility.** By induction (§4), each operation preserves the invariant, so after *any* sequence of nullifications the
  stored root is still the canonical root of the N-position tree; append (§4) needs only `(root, N)` and therefore composes with any
  null sequence. The reference model tests exactly the requested trace `append A, B, C; refund B; append D; refund A; append E;
  refund D; append F` and 100 randomized interleavings.
- **C. Arbitrary ordering.** The induction imposes no ordering on positions: `refund(7), refund(2), refund(91), refund(0)` all succeed
  provided each position is `< N` and not yet consumed.
- **D. Double refund.** After the first refund, position `k` holds `Z`. A second proof carries the genuine leaf `leaf_k ≠ Z`; its path
  reconstruction ends at the *previous* root, not the stored one → assertion fails. Deterministic rejection.
- **E. Amount binding.** `amount` is hashed into `leaf_k`; any modification produces a different leaf whose path reconstruction does not
  equal the stored root. The amount paid is exactly the amount committed by the authenticated leaf.
- **F. Sender binding.** The contract rebuilds `leaf_k` with `Txn.sender`; a leaf belonging to another backer would need a different
  preimage and fails the root check. The caller can only ever authenticate the leaf whose preimage contains their own address.
- **G. Transaction binding.** `paymentTxId` is part of the leaf preimage; it was read from the atomic group at pledge time, and any
  substitution at refund time breaks the leaf hash. (The contract does not need to *authenticate* the txid at refund time - the tree
  already did at pledge time.)

## 6. Frontier after deletions

After nullifications the frontier is **the canonical frontier of the current mutable value tree** - the same definition as §3, applied
to the current leaf values `(v_i ∈ {Z} ∪ leaves)`. Nulling position `k` changes exactly one frontier node: the peak containing `k`
(and, transitively, the root).

**Client/indexer reconstruction algorithm** (deterministic from public chain data):

1. Replay every pledge in (round, txn-index) order: each pledge app call's group contains the payment whose `(sender, amount, TxID)`
   are readable from the block; append `leaf = H(0x01 ‖ sender ‖ amount ‖ txid)` with the cascade of §4 - the frontier is maintained
   incrementally (O(popcount) work per pledge; no full tree needed).
2. Replay every nullifying call (cancel/refund/settle) in order: replace the leaf with `Z` at the given position, updating the nodes on
   its path.

Any sequence of such public events reconstructs the exact current frontier and root. A caller submits this frontier to `pledge()`; the
contract authenticates it against `(storedRoot, N)` with `fold` (§4) - the contract **never stores the frontier**. If the supplied
frontier is stale or fabricated, the fold check fails and the transaction is rejected (retry with fresh data).

## 7. Concurrency and stale proofs

Relied-upon consensus property: **Algorand applies transactions serially** - each transaction's execution observes all prior confirmed
state; a group is atomic (all-or-nothing). Two refunds constructed against the same root `R₀`:

- **A executes first** (`R₀ → R₁`), nulling leaf 10.
- **B's proof is against `R₀`.** Every leaf's authentication path includes the root; after any null, `R₁ ≠ R₀` and B's reconstruction
  lands on `R₀ ≠ R₁` → the assertion fails → **B is rejected atomically, nothing is written.** This holds for both overlapping and
  disjoint paths (the root is on every path). B's client must re-fetch the path (from the public tree state) and retry - an explicit,
  expected retry semantic, identical to stale-nonce handling.
- **Stale-root overwrite is impossible by construction:** the contract never writes a caller-supplied root; it writes only the root it
  recomputed from its own stored state plus a verified proof.
- **Refund vs append (during OPEN):** serialized; the append authenticates the frontier of the post-null tree (a stale frontier fails
  the fold check); the null verifies against the post-append root (a stale path fails). Whichever is second fails deterministically and
  retries.
- **Campaign deletion vs refund:** the settlement box is written atomically by `delete()` (via the inner `settle`); a refund racing it
  either executes before (against the campaign root, path `payBack`) or after (against the vault box) - both are valid; there is no
  interleaving in which a refund is lost.
- **Campaign deletion vs pledge:** the pledge group's `credit` requires the vault box to be absent or `OPEN`; a settle/deletion that lands
  first flips the box to `FAILED` → the pledge group reverts entirely.

## 8. Receipt design

A backer's proof data is **entirely reconstructable** from public chain history (pledge payment + app-call deltas are in the blocks;
positions, amounts, txids, and the tree are deterministic). The receipt is a *cache*, never a bearer secret.

- **Mandatory receipt data (recommended cache):** `campaignAppId (8) ‖ position k (8) ‖ amount (8) ‖ paymentTxId (32)` = 56 bytes.
- **Reconstructable:** the authentication path, the current tree/root, and `N` (campaign global-state delta at pledge time; the vault
  also stores `N` in the settlement box).
- **`N`-at-pledge-time is NOT part of the receipt** - the path structure is derived from `(k, N)` where `N` is the *current* stored
  value, which the client reads from on-chain state. (It was retained in an earlier draft out of caution; it is redundant.)
- **Cryptographically authenticated:** `(backer, amount, txid)` via the leaf hash; `k` via the path; the whole tree via the stored root.
  Nothing in the receipt is a secret; possession of the receipt data without control of the backer's address is worthless (§5-F).

## 9. Exact transaction protocol

Two contracts: **Campaign** and **ClaimsVault**, plus the **Factory** registry. The vault holds all funds; the campaign escrow holds
**nothing** (no deposit, no asset).

### Campaign global state

`creator (Account)`, `vault (Application)`, `title (bytes)`, `metadataUri (bytes)`, `goal (uint64)`, `deadline (uint64)`,
`raised (uint64)`, `status (uint64)`, `root (bytes32)`, `N (uint64)`. Schema: 4 byte-slices + 6 uints (`vault` holds an app id).

### Vault global state and boxes

Global: `factory (Application)`, `refundWindow (uint64)`, `sweepTarget (Account)`.
Per campaign, one box, key = `c` ‖ appId (9 bytes), value (65 bytes):

```text
paidInOf   (8, BE) ‖ paidOutOf (8, BE) ‖ root (32) ‖ N (8, BE) ‖ status (1) ‖ settledAt (8, BE)
```

`status`: `1 = OPEN`, `2 = FAILED`, `3 = CLAIMED`. Box MBR = 2,500 + 400×(9+65) = **32,100 µA** (verified formula). No other
per-campaign state exists. The vault authenticates the campaign caller as
`Txn.sender == app.address` (only the app's own program can spend as its account) plus Factory registration on first touch (see
`credit`).

### Pledge

Group: `[Payment (backer → vault, amount a, note optional), Campaign.pledge(payment, frontier), Vault.credit(app, amount)]`
(the payment is immediately before the pledge, and the credit is immediately after it and the final transaction; atomicity
makes the order safe - if any of the three fails, nothing is written). Those positions are load-bearing: a transaction can
appear only once in a group, so the payment-before-pledge rule gives each pledge a distinct payment, the credit-immediately-
after rule pairs every pledge with its own inflow, the credit-last rule gives each credit a distinct payment, and the vault
requires the pledge immediately before the credit. Both calls must be `NoOp` (a `ClearState` call would bypass the method).
A standalone credit is rejected, so every payer is a backer and every inflow
counts toward the goal. Without these guards one payment could back several pledges or credits and inflate `paidInOf` past the
vault's actual balance, or a pledge could be left uncredited.

`Campaign.pledge` checks: deadline not passed; `status == OPEN`; `payment.receiver == vault.address`; `payment.sender == Txn.sender`;
`payment.amount > 0`; `payment.groupIndex == Txn.groupIndex − 1`; `Txn.sender != creator`; `frontier.length == 32·popcount(N)`;
and the next transaction is `Vault.credit(app, amount)` for this campaign (selector, app id, sender, NoOp, and amount are
asserted).
Computes `leaf = H(0x01 ‖ sender ‖ amount ‖ payment.txnId)`; asserts `leaf ≠ Z`; authenticates the frontier (§4); updates `root, N`;
`raised += amount`. No inner calls (a self inner call for budget would be illegal reentrancy - see §14 for the `ensureBudget`
mechanism instead).

`Vault.credit` (top-level, backer-signed) checks: `Txn.groupIndex == Global.groupSize − 1` (the credit is the group's final
transaction); the transaction immediately before it is `Campaign.pledge` for this `app` and caller (selector, app id, sender,
NoOp, and arg count are asserted), so a credit without a pledge is rejected and every inflow has a backer leaf; the vault box for
`app` is absent or `OPEN` (`FAILED`/`CLAIMED` reject - no pledges after settlement); if the box is absent: inner-call
`factory.isRegistered(app)` (result must be true; the Factory only registers campaigns whose `vault` global is the owner-bound
official vault) before creating it; **independently verify the payment**: the pledge requires the payment immediately before it,
so the committed payment is exactly `groupIndex − 2`; assert it is a payment from `Txn.sender` to the vault for `amount`, with no
`closeRemainderTo`/`rekeyTo`. Then `paidInOf += amount` (creating the box on first pledge). The vault's `paidInOf` therefore
counts only real pledge payments into the vault - the "derived, not trusted" property of the current design is preserved, per
campaign. Because a payment can appear only once in a group and `credit` is always last, one payment can credit at most one
campaign box.

`credit` requires the matching pledge, so a standalone payment cannot be credited: every payer is a backer, `raised` and the
tree count the amount, and a donation is expressed as a pledge the backer chooses not to refund. The reverse skew is also
impossible: a `pledge` must be immediately followed by its matching `credit`, so a leaf can never exist without the vault
recording the same payment. The group-position guards in `pledge` and `credit` are what prevent payment replay; without them a
single payment could back several leaves or several credits and the accounting invariants in §11 would not hold. `credit` is
top-level by construction: an inner-called app sees only its own inner group in `gtxn`, so an inner `credit` could never see
the outer payment, and a transaction argument to an inner call indexes the inner group too, so forwarding is no fix either.

### Cancel (pre-deadline withdrawal, while OPEN)

Group: `[Campaign.cancelPledge(k, amount, txid, path)]`. Checks: deadline not passed, `status == OPEN`, `k < N`, path length as
derived; verifies and nulls `k` (§5); `raised -= amount`; inner `vault.payBack(app, backer=Txn.sender, amount)`.

`Vault.payBack` checks: `Txn.sender == app.address`; box `status == OPEN`; `amount ≤ paidInOf − paidOutOf`; then `paidOutOf += amount`
and pays `backer`. (The vault-enforced balance guard is what keeps campaign bugs from draining other campaigns' funds - the pooled
vault's isolation invariant.)

### Refund, campaign alive (post-deadline, pre-delete; covers "creator vanished")

Group: `[Campaign.refund(k, amount, txid, path)]`. Checks: deadline passed; `raised < goal`; if `status == OPEN` set
`status = FAILED`; then `status == FAILED`; verify + null `k`; `raised -= amount`; inner `vault.payBack` (same guards). This path keeps
working forever as long as the campaign app exists, with no creator involvement.

### Refund, after settlement (campaign may be deleted)

Group: `[Vault.refund(app, k, amount, txid, path)]`. Checks: box exists, `status == FAILED`, `k < N`, refund window not expired
(§13), path length derived from `(N, k)`; rebuilds `leaf` from `(Txn.sender, amount, txid)`; verifies against the box's stored root;
nulls; asserts `amount ≤ paidInOf − paidOutOf`; `paidOutOf += amount`; pays `Txn.sender` from the pool. Runs entirely from vault-local
state - the campaign app is never read (it may be deleted; no `app_global_get_ex` on possibly-deleted apps is ever attempted).

### Successful settlement

`[Campaign.claim()]` (creator): deadline passed; `raised ≥ goal`; `status == OPEN`; set `CLAIMED`; inner `vault.payClaim(app)`.

Only the creator can claim. If a successful campaign's creator never claims, the funds stay in the vault and the backers cannot
refund. This is **accepted product behavior** (see [`design.md`](design.md)), not a contract bug: the creator is the party who
earned the funds, and the failed-campaign sweep does not apply to successful campaigns.

`Vault.payClaim`: `Txn.sender == app.address`; box `status == OPEN`; `payout = paidInOf − paidOutOf` (**derived, not trusted** - equal
to the live pledge total because cancels were balanced); pay creator (`Txn.sender` is the campaign app… the recipient is
`app.creator`, read via foreign app global state); `paidOutOf += payout`; `status = CLAIMED`.

`[Campaign.delete()]` (creator): requires `status == CLAIMED` (or `FAILED`, or `raised == 0`); inner `vault.notifyDelete(app)` which
asserts `status == CLAIMED` and `paidInOf == paidOutOf`, then deletes the box (recovering the 32,100 µA) - **O(1), vault parks nothing
for successful campaigns**. `notifyDelete` is a no-op when the box was already released, so deletion still works after a
permissionless cleanup. When the campaign's vault has a Factory binding, `delete()` requires the Factory's `unregister` to be the
immediately preceding transaction (a `NoOp` call; `ClearState` would bypass it); the Factory requires the delete to be the
immediately following one. The group is exactly
`[Factory.unregister(app), Campaign.delete()]`, so delisting and deletion are one operation and a raw delete of an official
campaign is rejected. Unregister reads the campaign's `status`/`raised`/`goal`/`deadline` and rejects a live campaign; the delete
then settles/releases the box. Zero-pledge and all-cancelled campaigns clean up immediately. An unregistered campaign's
`unregister` is a no-op (still shaped with the delete next), so the same group cleans up a registration that never landed.

`[Vault.releaseClaimed(app)]` (**permissionless**): asserts the box is `CLAIMED` with `paidInOf == paidOutOf`, then deletes it. This
recovers the box's 32,100 µA even when a creator claims and then never deletes the campaign, so claimed boxes cannot pin the vault's
minimum balance forever. It cannot re-open a box: a later credit for the same campaign is rejected because the box is `CLAIMED`
(and `credit` requires a preceding pledge, which a settled campaign cannot produce).

### Failed settlement

Either path, converging on the same box state:

- `[Campaign.delete()]` on a failed campaign (creator): inner `vault.settle(app, root, N)` - asserts `Txn.sender == app.address`; if
  box `status == OPEN`: write `root, N, settledAt = latestTimestamp, status = FAILED`; if already `FAILED`: no-op.
- `[Vault.settleOpen(app)]` (**permissionless**, for a missing creator): asserts box `status == OPEN`; reads the campaign app's
  foreign global state (`status`, `root`, `N`, `raised`, `goal`, `deadline`, `vault` - the app still exists); asserts the campaign
  `vault` is this vault and the `root` is exactly 32 bytes; asserts deadline passed and `raised < goal`; writes
  `root, N, settledAt = now, status = FAILED`. After this, campaign-driven `payBack` is rejected (box not OPEN) and all refunds
  flow through the vault.

Then: refunds per §9 until the window closes (§13); then `[Vault.finalize(app)]` (permissionless): asserts `status == FAILED` and
(`paidInOf == paidOutOf` or `latestTimestamp ≥ settledAt + refundWindow`); pays `paidInOf − paidOutOf` to `sweepTarget`; deletes
the box. A fully paid-out box can be finalized immediately (nothing is left to refund). **O(1).**

### Cross-campaign note

Every inner call names its own app id; the `Txn.sender == app.address` check makes cross-campaign calls impossible (an app account
acts only through its own program; app addresses are distinct). The top-level `credit` names its app id explicitly as an argument; a
misattributed `credit` (paying under the wrong campaign's box) locks the caller's own funds under that campaign's balance cap - self-harm,
no theft (§17 #31).

### Resource declaration (outer transactions)

Every outer transaction that triggers inner vault calls declares the vault's campaign box in `boxReferences` and the vault app in
`appReferences`; on first-touch paths (`credit` creating the box) it additionally declares the factory app plus its registration box
(`'r' ‖ appId`), so the inner `isRegistered` call resolves under v9+ group resource sharing. The frontend builds these from the
vault/factory app ids plus the campaign app id.

## 10. State layout

Exactly as §9: campaign = 10 global slots; vault = one 65-byte box per campaign
(live and failed; deleted on claim-finalization or finalize). **No local state, no ASA, no per-backer storage anywhere.** Campaign
account balance: 0 (never funded). MBR: creator = app creation (100,000) + schema (4×50,000 + 6×28,500 = 371,000) + 1 extra page
(100,000) + registration (18,900) = **589,900 µA (~0.59 ALGO)**, fully recovered in the atomic `[unregister, delete]` group; vault = 32,100 µA
per live/failed campaign, recovered via `notifyDelete`/`releaseClaimed`/`finalize`; backer = **0**. The 1-page target is ~0.49 ALGO;
see [`limits.md`](limits.md) for the current footprint and the page-boundary rule.

## 11. Accounting and solvency

Invariants (all enforced by the contract, none rely on the indexer):

1. `paidInOf` increments only with a payment the vault itself verified in-group (§9 `credit`) → `paidInOf` = total µA this campaign
   actually paid into the pool.
2. `paidOutOf` increments only via `payBack` (cancels/live refunds), `payClaim`, and vault refunds, each guarded by
   `amount ≤ paidInOf − paidOutOf` → `paidOutOf ≤ paidInOf` at every instant.
3. Every refund pays exactly the amount committed by the authenticated leaf (§5-E). Every leaf amount was part of a verified
   payment, every pledge was immediately followed by its matching `credit`, and each payment backs at most one leaf and at most
   one credit (§9 group-position guards) → `refunds + cancels + claim ≤ paidInOf`.
4. `finalize` pays exactly `paidInOf − paidOutOf` → **total outflows = total inflows per campaign**:
   `paidInOf = cancels + liveRefunds + vaultRefunds + (claim payout) + (finalize residual)`.
5. **Pooled isolation:** all outflows are per-campaign capped by the per-campaign balance guard (2), so campaign A's funds can never
   pay campaign B - enforced at the vault, not by code review.

## 12. State machines

### Campaign app

```text
OPEN ──pledge──▶ OPEN            (deadline not passed)
OPEN ──cancelPledge──▶ OPEN      (nulls a leaf; raised −= amount)
OPEN ──refund (deadline passed, raised < goal)──▶ FAILED
OPEN ──claim (deadline passed, raised ≥ goal)──▶ CLAIMED
CLAIMED ──delete──▶ (deleted)    (requires CLAIMED)
FAILED ──delete──▶ (deleted)     (inner vault.settle)
OPEN with raised == 0 ──delete──▶ (deleted)   (abandoned)
OPEN, failed-in-fact (deadline passed, raised < goal) ──delete──▶ (deleted)   (settle, then close)
```

Illegal: pledge/cancel after deadline or when status ≠ OPEN; claim before deadline or below goal; delete with live pledges
on a live campaign (`raised > 0`, OPEN, deadline not passed or goal met); refund when `raised ≥ goal`; double claim/delete (app is gone).

### Vault box

```text
absent ──credit──▶ OPEN          (first pledge; campaign must exist + be OPEN, Factory check on creation)
OPEN ──credit/payBack──▶ OPEN
OPEN ──payClaim──▶ CLAIMED ──notifyDelete/releaseClaimed──▶ absent
OPEN ──settle (campaign delete)──▶ FAILED
OPEN ──settleOpen (permissionless)──▶ FAILED
FAILED ──refund──▶ FAILED        (window open; paidOutOf grows)
FAILED ──finalize──▶ absent      (window closed or fully paid out; residual to sweepTarget)
```

Illegal: credit/payBack on a FAILED/CLAIMED box; credit on a deleted/Failed/Claimed campaign with no box; credit without a
preceding `Campaign.pledge`; refund on OPEN/CLAIMED/absent boxes or after the window; finalize on OPEN/CLAIMED or before the
window unless fully paid out; double settle (idempotent no-op); double finalize (box absent → reject).

### Edge cases

- **Zero pledges:** box may be absent; `delete()` on `raised == 0` succeeds (`settle` no-ops without a box).
  `settleOpen` requires an existing box and rejects an absent one - no stranded state.
- **One pledge:** tree of one leaf; refund path length 0; works.
- **Last pledge immediately before deadline:** pledge group lands while `latestTimestamp < deadline` (consensus serialization); it is
  either included or not; no partial state.
- **Refund immediately before deadline:** takes the `cancelPledge` path (OPEN); identical null mechanics.
- **Delete immediately after deadline:** below goal → `settle`; above goal with `raised > 0` and OPEN → rejected (must claim first).
- **Creator disappears on a failed campaign:** `settleOpen` (permissionless) opens vault refunds forever after.
- **Backer/all backers disappear:** nothing waits on them (§10 of the adversarial matrix in the reference model docstring);
  `finalize` sweeps the residual O(1).
- **Creation followed by abandonment:** `raised == 0` delete path; no box; nothing parked anywhere.
- **Repeated finalization / settlement:** absent-box or idempotence guards above.

## 13. Refund window decision

**Option A - refunds forever.** The 32,100 µA anchor box per failed campaign is retained indefinitely, and the residual
`paidInOf − paidOutOf` stays in the pool forever. This fails requirement B in its strict letter (the box is protocol capital whose
recovery is blocked by any single never-refunding backer) - by a constant, but still a violation, and it leaves an ever-growing
liability on the pool.

**Option B - bounded refund window.** `refundWindow` is a vault-global constant (730 days) set at vault
creation, immutable. Refunds are accepted while `latestTimestamp <= settledAt + refundWindow`. Afterwards `finalize()` is
permissionless and O(1): the residual `paidInOf − paidOutOf` is paid to `sweepTarget` (the platform treasury, set at vault
creation). A fully paid-out box (`paidInOf == paidOutOf`) has nothing left to refund and can be finalized immediately, so
all-cancelled campaigns do not pin their MBR for the window.

Requirement impact: **A** - fully satisfied within the publicly-known window; the window is visible in the vault state from
day one and disclosed in the UI at pledge time, so it is part of the pledge contract, not a hidden rule. **B** - strictly satisfied:
every protocol resource (the box) and every liability (the residual) has a time-bounded, backer-independent recovery path; recovery
is one transaction. **C/D/E/F** - unaffected. Economic acceptability of the sweep: the residual represents backers who, over the full
window, never exercised a right they were offered at pledge time; the alternative (Option A) keeps their funds inert forever.
If the platform wants zero self-enrichment optics, `sweepTarget` can be a documented community fund - a governance decision, not a protocol change.

**Deployed choice:** `sweepTarget` is the platform treasury.
The 730-day window and the sweep destination are disclosed in the UI at pledge time (refund-window banner). The vault contract
and deploy script both cap the window at 10 years, so a misconfiguration cannot overflow `settledAt + refundWindow`; the contract
also rejects a zero/self `sweepTarget` and a zero `factory` at creation. The deploy script requires an explicit `SWEEP_TARGET` on
TestNet/MainNet; LocalNet still defaults to the deployer for convenience.
Rationale:
residuals will be dust; a future vault can point at a community fund instead - the address is a vault-creation parameter,
so no contract change is needed either way. The creator as sweep target was rejected (rewards failure, looks like a backdoor).

## 14. Opcode and resource analysis

Derived from the verified reference model (not estimates):

| N | popcount(N) | pledge `H` calls (2·popcount) | worst-case refund path length | refund `H` calls (2·path+1) |
| --- | --- | --- | --- | --- |
| 1 | 1 | 2 | 0 | 1 |
| 10 | 2 | 4 | 4 | 9 |
| 100 | 3 | 6 | 8 | 17 |
| 1,000 | 6 | 12 | 14 | 29 |
| 10,000 | 5 | 10 | 17 | 35 |
| 65,535 (2¹⁶−1) | 16 | 32 | 30 | 61 |
| 65,536 (2¹⁶) | 1 | 2 | 16 | 33 |
| 100,000 | 6 | 12 | 21 | 43 |
| 131,071 (2¹⁷−1) | 17 | 34 | 32 | 65 |
| 131,072 (2¹⁷) | 1 | 2 | 17 | 35 |
| 1,000,000 | 7 | 14 | 25 | 51 |

Worst case for pledge is `N = 2ᵏ−1` (maximal popcount); worst case for refund is a leaf at position 0 of `N = 2ᵏ−1`
(path = `(k−1) + (k−1) = 2k−2`).

Budget model: `ops = H_calls × 35 + ~150` (ABI decode, box access, asserts, inner-call emission, payment check). Available pool =
`700 × (top-level app calls)` plus `700` per inner app call submitted, under v30+ pooling
([specs](https://specs.algorand.co/avm/avm-mode-applications)). Inner calls to *oneself* are forbidden (reentrancy is explicitly
excluded - [Inner Transactions](https://dev.algorand.co/concepts/smart-contracts/inner-txn/)), so heavy methods size
`ensureBudget(requiredOps)` - the Puya OpUp utility, which adds budget with inner app *creates* of ephemeral programs
(created and deleted in one inner group; the pattern production Puya code uses, e.g. `ensure_budget(20000)` in the
[voting example](https://github.com/algorandfoundation/puya/blob/main/examples/voting/voting.py)), paid by the caller via
`GroupCredit` fee pooling. OpUp inners needed: `ceil(ops/700) − pool/700`:

- **Pledge** (group: 2 app calls → pool 1,400; no campaign inners): N=10,000 → 10·35+150 = 500 (+`credit` ≈ 150) ✓ headroom large;
  worst realistic N=131,071 → 34·35+150 = 1,340 (+150) → 1 OpUp inner (2,100) ✓. Only `N ≥ 2²⁰−1`-class trees need a second one.
- **Refund, campaign path** (1 app call + 1 inner `payBack` → pool 1,400): N=1,000 → 1,165 ✓; N=10,000 → 1,375 ✓ (tight - size one
  OpUp headroom anyway); N=131,071 → 2,425 → 2 OpUp inners (2,800) ✓; N=1,000,000 → 1,935 → 1 ✓.
- **Refund, vault path** (1 app call + 0 inner app calls → pool 700): same `ops` as above, so N=1,000 → 1 OpUp inner (1,400) ✓;
  N=131,071 → 3 OpUp inners (2,800) ✓.

The contract calls `ensureBudget` itself with the estimate above. The SDK currently funds a **fixed** extra fee
(`FEE_SPEND_EXTRA = 3,000`, `FEE_CREDIT_EXTRA = 1,000`), not a value derived from `(N, k)`: it covers one OpUp iteration
plus the payout/inner call and overpays small trees; large trees that need 2–3 OpUp iterations can be underfunded. Dynamic
sizing is tracked in [issue #77](https://github.com/kasakame/kasakame/issues/77). An underfunded transaction fails atomically with no partial state; the client
retries with a higher fee.

Current program footprint (2026-11-04, `npm run build`; see [`limits.md`](limits.md) for the full table):

| Contract | Approval + clear | Pages | App MBR |
| --- | ---: | ---: | ---: |
| Campaign | 2,069 B | 2 (1 extra) | 571,000 µA |
| ClaimsVault | 2,759 B | 2 (1 extra) | 307,000 µA |
| Factory | 1,036 B | 1 | 357,000 µA |

Resource ceilings (hard limits, not Big-O):

- **Arguments:** refund args `appId(8) ‖ k(8) ‖ amount(8) ‖ txid(34) ‖ path(2+32·pathLen)`; total ≤ 2,048 B ⇒ pathLen ≤ 62 ⇒
  **N ≤ 2³²−1** (4.29 billion backers). Pledge frontier: `32·p + ~20` B ⇒ p ≤ 62 ⇒ N ≤ 2³²−1.
- **Box IO:** refund reads+writes one 65-byte box (1 ref → 2,048 B budget) ✓; `credit` writes the same box ✓.
- **Group size:** 3 top-level transactions on pledge (limit 16); inner transactions 16 per app call / 256 per group; the
  protocol uses at most 5 inner txns per operation (OpUp creates + vault/factory calls) ✓.
- **Stack:** values ≤ 32 B each during hashing (leaf preimage 73 B once); depth < 20 ✓.
- Fees: each OpUp iteration is a create + delete inner pair, ≈ +2,000 µA via `GroupCredit`; each inner app call also adds 700
  ops. Typical campaigns (N ≤ ~10k) need no OpUp: pledge ≈ 3× minimum (pay + 2 app calls), first touch +1 inner Factory check =
  4×; campaign-path refund ≈ 2×, vault-path refund ≈ 1×. The SDK's fixed extras make pledge/spend 4,000 µA even when no OpUp is
  needed. Worst-case trees (N ≈ 131k) add 2–3 OpUp iterations: pledge ≈ 4–5×, refund ≈ 5–6×. Flat in the common case, growing
  only with `log N`-class path lengths at extreme N.

## 15. Reference implementation

[`claim-tree-protocol-reference.py`](claim-tree-protocol-reference.py) - language-independent (Python 3, stdlib only), implements
`leaf`, `build_nodes`, `peaks`, `fold`, `root_of`, `append`, `path_of`, `verify`, `null`, and runs these property tests:

- fold == naive tree root, N = 1..299;
- append == naive root over 500 random append sequences;
- **exhaustive** verification + full null-sequences + double-null rejection for **every** leaf pattern at every N ≤ 12;
- randomized verify/arbitrary-null-order/double-null at N ∈ {13, 31, 63, 64, 100, 255, 256, 1000};
- 100 random mixed append/null sequences (the append-after-null invariant);
- stale-proof rejection; amount/txid/sender binding; the exact `2·popcount(N)` pledge-cost identity;
- worst-case path-length table (reproducing §14).

## 16. Differential testing plan

The contract test suite covers, for every operation sequence (thousands of randomized `append/null` interleavings, all boundary N, the
traces from §5-B and §10 of the adversarial matrix): assert

```text
reference_root == onchain_root
reference_N    == onchain_N
reference_raised == onchain_raised (campaign paths)
reference_paidInOf/paidOutOf == vault box values
```

plus negative differentials: every proof the reference model rejects (stale, forged, double, wrong-amount, wrong-sender, wrong-k)
must be rejected by the contract with the same result. The simulator tests run the full sequences; the LocalNet integration tests run
the end-to-end groups of §9 (pledge, cancel, live refund, settleOpen, post-delete refund, finalize, claim/delete/notifyDelete) against
real consensus, including the races of §7.

## 17. Adversarial security analysis

| # | Attack | Why it fails | Layer |
| --- | --- | --- | --- |
| 1 | Forged leaf | leaves are created only by `pledge()`, contract-computed from the verified payment | app checks + AVM |
| 2 | Forged amount | amount is hashed into the leaf; modification breaks root verification | SHA-512/256 |
| 3 | Forged sender | leaf preimage binds `Txn.sender` | app checks + SHA |
| 4 | Forged TxID | txid committed in the leaf at pledge time | SHA |
| 5 | Forged position | path is verified against the stored root at exactly position k | SHA |
| 6 | Forged Merkle path | sibling tuple must reconstruct the stored root | SHA |
| 7 | Forged frontier | fold(frontier) must equal the stored root | SHA |
| 8 | Second refund | position holds `Z` after the first refund; re-proof fails | SHA + AVM state |
| 9 | Refund of another's pledge | leaf binds sender | app checks + SHA |
| 10 | Stale proof | rejected against the mutated root (§7) | AVM serialization |
| 11 | Stale frontier | fold ≠ current root | SHA |
| 12 | Cross-campaign proof | box is keyed by app id; root is campaign-specific | app checks |
| 13 | Cross-campaign TxID | the txid alone proves nothing; the tree it hashes into is campaign-specific | SHA |
| 14 | Malformed path | path length is asserted from (N, k) | app checks |
| 15 | Path-length manipulation | length check above; mis-sized paths are structurally rejected | app checks |
| 16 | `Z` as forged leaf | `leaf ≠ Z` asserted at append; a `Z` "leaf" fails verification | app checks + SHA |
| 17 | Hash collision | SHA-512/256 collision resistance (the chain's own assumption) | SHA |
| 18 | Second-preimage on nodes | a replacement sibling must fold to the stored root | SHA |
| 19 | Integer overflow | amounts are uint64 with `amount ≤ paidInOf − paidOutOf` and AVM's wrapping-free arithmetic; `paidInOf` counts real payments | AVM + app checks |
| 20 | Accounting overflow | the balance guard makes over-pay impossible regardless of campaign bugs | app checks |
| 21 | Pooled vault insolvency | per-campaign guard: outflows ≤ that campaign's verified inflows | app checks |
| 22 | Malicious creator | cannot touch `paidInOf`/`paidOutOf` or the root; claim pays only the derived balance; delete cannot steal pledges (`raised > 0` guard) | app checks |
| 23 | Malicious backer | all refund powers reduce to proving their own committed leaf | SHA + app checks |
| 24 | Abandoned campaign | `raised == 0` cleanup via the atomic `[unregister, delete]` group; `settleOpen`; no stranded state | app checks + AVM group shape |
| 25 | Deletion race | atomic groups; box state transitions are asserted, never blind-written | AVM atomicity |
| 26 | Finalize race | window + status assertions; absent-box reject | app checks |
| 27 | Repeated finalize | box absent after first | app checks |
| 28 | Malicious indexer data | the indexer is never trusted: every supplied structure (frontier, path) is authenticated by the contract against on-chain state; wrong indexer data only causes a rejected transaction and a retry | SHA + app checks |
| 29 | `credit` without a matching `pledge` | rejected: `credit` requires the campaign's `pledge` as the immediately preceding NoOp transaction, so every inflow has a backer leaf and counts toward `raised`/the goal. A donor can pledge and choose not to refund. | app checks |
| 29a | One payment reused for several pledges or credits | `pledge` requires the payment immediately before it and `credit` must be the group's final transaction; a transaction can appear only once per group, so each payment backs at most one pledge and one credit - `paidInOf` cannot be inflated by replaying a payment | app checks + AVM group shape |
| 30 | Inner self-call for budget (`self.reserve()`) | forbidden by consensus (reentrancy); heavy methods use `ensureBudget` OpUp creates instead (§14) | AVM |
| 31 | `credit` under another campaign's box | the box is keyed by the caller-supplied app id and creation is registration-gated; misattribution locks the caller's own funds under that campaign's cap | app checks |
| 32 | `credit` after the campaign app is deleted or settled | a deleted or settled campaign cannot produce a valid `pledge`, and `credit` requires the pledge immediately before it, so no box can be created; an existing `FAILED`/`CLAIMED` box rejects credit | app checks + AVM |
| 33 | Campaign registered with a different vault | the Factory stores the official vault id and `register` reads the campaign's `vault` global; a mismatch is rejected. Clients also pin the vault and `pledge` checks the payment receiver. | app checks |
| 34 | Delisted campaign keeps taking pledges | `Factory.unregister` requires the campaign's `delete()` as the immediately following transaction, and the campaign requires the `unregister` immediately before it (NoOp on both sides); delisting and deletion are atomic, so no live campaign can remain outside the registry. | app checks + AVM group shape |
| 35 | Raw delete leaves the registration behind | `Campaign.delete` requires the Factory's `unregister` immediately before it when the vault has a Factory binding; a standalone delete of an official campaign is rejected. An unregistered campaign's `unregister` is a no-op so the same cleanup group still works. | app checks + AVM group shape |
| 36 | `ClearState` paired-call bypass | every paired call must be a `NoOp` app call; `ClearState` runs the clear-state program and cannot satisfy the pledge/credit or unregister/delete checks | app checks + AVM |
| 37 | Custom clear-state program | `Factory.register` hashes `sha256(itob(approval.length) ‖ approval ‖ clear)`. The 8-byte length prefix binds the approval/clear split, so a copy that moves bytes between the two programs is rejected. | SHA + app checks |

## 18. Six-requirement scorecard

| Requirement | Status | Proof |
| --- | --- | --- |
| A - Backer-controlled refund | ✓ | Self-service `refund`/`cancelPledge` from wallet alone; works after campaign deletion and after creator disappearance (`settleOpen`); no creator/platform processing exists on any refund path. Satisfied **within the refund window** under Option B. |
| B - Complete bounded finalization | ✓ with Option B | Protocol resources per campaign = one 32,100 µA box; recovered by `notifyDelete` (claimed) or `finalize` (failed, time-gated) - one transaction, independent of N and of any backer. Without the window (Option A), fails by a constant. |
| C - No O(N) platform operations | ✓ | No platform operation is per-backer anywhere; frontiers/proofs are computed by backers' own clients and *verified* by the contract. |
| D - Very high scalability | ✓ | Zero per-backer on-chain structures (no ASA, no boxes-per-backer, no local state, no bitmap). Per-campaign state is constant (10 global slots + one box). Single-call refunds to N ≈ 1,000; `ensureBudget`-pooled refunds to N ≈ 131k with ≤ 3 OpUp inners (§14); argument ceiling N ≤ 2³²−1. |
| E - Minimal creator capital | ✓ | ≈ 0.59 ALGO now (2-page campaign: app + schema + extra page MBR + registration), fully recovered at `delete()`; the 1-page target is ≈ 0.49 ALGO. See [`limits.md`](limits.md). |
| F - Zero backer action after success | ✓ | Backers hold nothing on-chain after success: no ASA, no opt-in, no local state, nothing to close, sweep, or destroy. |

## 19. Verdict

**Verdict: GO.** The Incremental Frontier-Merkle with In-Place Null-Deletion is formally coherent: append and arbitrary nullification compose by a
single induction invariant (validated exhaustively for N ≤ 12 and randomized to N = 1,000 in the reference model), the contract is the
sole committer (no auditor, no oracle, no trusted list), all security reduces to SHA-512/256 collision resistance plus the checks of
§17, and the resource model (§14) holds within current AVM limits for every realistic campaign size. Requirements A–F hold as scored
in §18, with the refund window (Option B) being the one explicit, documented condition attached to A and B.

Contracts, tests, and frontend follow §§2–12; `claim-tree-protocol-reference.py` backs the differential test plan in §16.
