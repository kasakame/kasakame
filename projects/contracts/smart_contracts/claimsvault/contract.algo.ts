import type { Account, Application, bytes, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  BoxMap,
  Bytes,
  Contract,
  Global,
  GlobalState,
  OnCompleteAction,
  OpUpFeeSource,
  TransactionType,
  Txn,
  Uint64,
  abimethod,
  assert,
  ensureBudget,
  gtxn,
  itxn,
  op,
  urange,
} from '@algorandfoundation/algorand-typescript'
import {
  CAMPAIGN_STATUS_CLAIMED,
  LEAF_DOMAIN_HEX,
  MAX_REFUND_WINDOW_SECONDS,
  MAX_TREE_SIZE,
  MAX_UINT64,
  MIN_REFUND_WINDOW_SECONDS,
  SPEND_BASE_COST,
  SPEND_ELEMENT_COST,
  VAULT_BOX_BYTES,
  VAULT_BOX_N_OFFSET,
  VAULT_BOX_PAID_IN_OFFSET,
  VAULT_BOX_PAID_OUT_OFFSET,
  VAULT_BOX_ROOT_OFFSET,
  VAULT_BOX_SETTLED_AT_OFFSET,
  VAULT_BOX_STATUS_CLAIMED_HEX,
  VAULT_BOX_STATUS_FAILED_HEX,
  VAULT_BOX_STATUS_OFFSET,
  VAULT_BOX_STATUS_OPEN_HEX,
} from '@kasakame/constants/source'

/**
 * ClaimsVault - the permanent pooled refund escrow for kasakame campaigns; per-campaign balance guards keep funds isolated (see docs/claim-tree-protocol.md).
 */

// Vault box statuses (1 byte in the packed box): 1 = Open, 2 = Failed, 3 = Claimed.
const BOX_OPEN = Bytes.fromHex(VAULT_BOX_STATUS_OPEN_HEX)
const BOX_FAILED = Bytes.fromHex(VAULT_BOX_STATUS_FAILED_HEX)
const BOX_CLAIMED = Bytes.fromHex(VAULT_BOX_STATUS_CLAIMED_HEX)

// `H(0x01)` leaf domain prefix, shared with Campaign.
const LEAF_DOMAIN = Bytes.fromHex(LEAF_DOMAIN_HEX)

// Packed vault box layout: paidIn ‖ paidOut ‖ root ‖ n ‖ status ‖ settledAt, with the offsets in @kasakame/constants.

// ARC-4 selector for Registry.isRegistered(uint64)bool; checked before a campaign's first box so an unregistered campaign cannot park the vault's MBR.
const REGISTRY_IS_REGISTERED_SELECTOR = Bytes.fromHex('716a3d0e')

// The ARC-4 bool return of the Registry's `isRegistered`: the return-value prefix (0x151f7c75) followed by 0x80 (true).
const REGISTRY_REGISTERED_TRUE = Bytes.fromHex('151f7c7580')

// ARC-4 selector for Campaign.pledge(pay,byte[])void; the credit immediately follows it, so every vault inflow is tied to a backer leaf.
const CAMPAIGN_PLEDGE_SELECTOR = Bytes.fromHex('a4030bd2')

export class ClaimsVault extends Contract {
  /**
   * The Registry app id, stored in the `registry` key; its `registered` boxes are the canonical campaign records.
   */
  registry = GlobalState<Application>()

  /** Where `finalize()` sweeps a failed campaign's residual after the refund window; fixed at creation. */
  sweepTarget = GlobalState<Account>()

  /** Refund window in seconds after settlement; fixed at creation. */
  refundWindow = GlobalState<uint64>()

  /** Campaign app id → packed box (paidIn ‖ paidOut ‖ root ‖ n ‖ status ‖ settledAt); absent until first `credit`. */
  campaignBox = BoxMap<uint64, bytes>({ keyPrefix: 'c' })

  /**
   * Deploy the vault; the platform funds its account afterwards, since each campaign's first `credit` parks a box on it.
   *
   * @param registry The Registry app (stored in the `registry` key).
   * @param target Where `finalize()` sweeps failed campaigns' residuals after the refund window.
   * @param window Refund window in seconds after settlement.
   */
  @abimethod({ onCreate: 'require' })
  create(registry: Application, target: Account, window: uint64): void {
    assert(Global.callerApplicationId === Uint64(0), 'must be called from the top level')
    assert(Txn.applicationId.id === 0, 'must be called on app creation')
    assert(registry.id !== Uint64(0), 'registry required')
    assert(target !== Global.zeroAddress, 'sweep target must not be zero')
    assert(target !== Global.currentApplicationAddress, 'sweep target must not be the vault')
    assert(target !== registry.address, 'sweep target must not be the registry')
    // A 1-second window is not credible; cap at 10 years so `settledAt + refundWindow` cannot overflow.
    assert(window >= Uint64(MIN_REFUND_WINDOW_SECONDS), 'refund window too short')
    assert(window <= Uint64(MAX_REFUND_WINDOW_SECONDS), 'refund window too long')

    this.registry.value = registry
    this.sweepTarget.value = target
    this.refundWindow.value = window
  }

  /**
   * Record one pledge payment into a campaign's box: the NoOp group must be [Payment, Campaign.pledge, Vault.credit], tying every inflow to a backer leaf and one payment to one credit.
   *
   * @param app The campaign application.
   * @param amount The pledged amount, in microAlgos.
   */
  @abimethod()
  credit(app: Application, amount: uint64): void {
    assert(Global.callerApplicationId === Uint64(0), 'must be called from the top level')
    assert(amount > Uint64(0), 'pledge must be greater than zero')
    assert(Txn.groupIndex === Global.groupSize - Uint64(1), 'credit must be the final transaction in the group')

    // The credit is the second half of the pledge: the preceding transaction must be the campaign's `pledge`, keeping every inflow tied to a leaf.
    assert(Txn.groupIndex > Uint64(1), 'credit must follow pledge')
    const pledgeIndex: uint64 = Txn.groupIndex - Uint64(1)
    assert(gtxn.Transaction(pledgeIndex).type === TransactionType.ApplicationCall, 'credit must follow pledge')
    const pledgeCall = gtxn.ApplicationCallTxn(pledgeIndex)
    assert(pledgeCall.appId.id === app.id, 'credit pledge app mismatch')
    assert(pledgeCall.sender === Txn.sender, 'credit pledge sender mismatch')
    assert(pledgeCall.onCompletion === OnCompleteAction.NoOp, 'credit pledge must be a NoOp call')
    assert(pledgeCall.numAppArgs === Uint64(2), 'credit pledge args mismatch')
    assert(pledgeCall.appArgs(Uint64(0)) === CAMPAIGN_PLEDGE_SELECTOR, 'credit pledge selector mismatch')

    const existing = this.campaignBox(app.id).get({ default: Bytes() })
    if (existing.length !== Uint64(0)) {
      assert(existing.slice(VAULT_BOX_STATUS_OFFSET, VAULT_BOX_SETTLED_AT_OFFSET) === BOX_OPEN, 'campaign is not open')
    }

    // Independent payment verification: the pledge requires the payment immediately before it, so the committed payment is exactly `groupIndex - 2`.
    const paymentIndex: uint64 = Txn.groupIndex - Uint64(2)
    assert(gtxn.Transaction(paymentIndex).type === TransactionType.Payment, 'matching payment not found in group')
    const payment = gtxn.PaymentTxn(paymentIndex)
    assert(payment.sender === Txn.sender, 'matching payment not found in group')
    assert(payment.receiver === Global.currentApplicationAddress, 'matching payment not found in group')
    assert(payment.amount === amount, 'matching payment not found in group')
    assert(payment.closeRemainderTo === Global.zeroAddress, 'payment must not close')
    assert(payment.rekeyTo === Global.zeroAddress, 'payment must not rekey')

    if (existing.length === Uint64(0)) {
      this.checkRegistration(app)
      /* v8 ignore next - see checkRegistration; covered on LocalNet. */
      this.createBox(app.id, amount)
    } else {
      const paidIn: uint64 = op.btoi(existing.slice(VAULT_BOX_PAID_IN_OFFSET, VAULT_BOX_PAID_OUT_OFFSET))
      assert(paidIn <= Uint64(MAX_UINT64) - amount, 'paidIn overflow')
      this.campaignBox(app.id).value = this.packBox(
        paidIn + amount,
        op.btoi(existing.slice(VAULT_BOX_PAID_OUT_OFFSET, VAULT_BOX_ROOT_OFFSET)),
        existing.slice(VAULT_BOX_ROOT_OFFSET, VAULT_BOX_N_OFFSET),
        op.btoi(existing.slice(VAULT_BOX_N_OFFSET, VAULT_BOX_STATUS_OFFSET)),
        BOX_OPEN,
        op.btoi(existing.slice(VAULT_BOX_SETTLED_AT_OFFSET, VAULT_BOX_BYTES)),
      )
    }
  }

  /**
   * Verify a first-touch campaign against the Registry via an inner call, so an unregistered campaign can never park the vault's minimum balance.
   *
   * @param app The campaign application.
   */
  /* v8 ignore next - the offline ledger cannot emulate the inner call's log; covered on LocalNet (test/04-bad-paths, CON-107). */
  private checkRegistration(app: Application): void {
    const registrationCheck = itxn
      .applicationCall({
        appId: this.registry.value,
        appArgs: [REGISTRY_IS_REGISTERED_SELECTOR, op.itob(app.id)],
        fee: Uint64(0),
      })
      .submit()
    assert(registrationCheck.lastLog === REGISTRY_REGISTERED_TRUE, 'campaign not registered')
  }

  /**
   * Create a campaign's box on first touch (paid-in inflow, zeroed tree fields, Open).
   *
   * @param appId The campaign application id.
   * @param amount The first verified inflow, in microAlgos.
   */
  /* v8 ignore next - reachable only for registered campaigns (see checkRegistration); covered on LocalNet. */
  private createBox(appId: uint64, amount: uint64): void {
    this.campaignBox(appId).value = this.packBox(amount, Uint64(0), this.zeroRoot(), Uint64(0), BOX_OPEN, Uint64(0))
  }

  /**
   * Pay a backer for a cancellation or campaign-driven refund; only the campaign's own app account may call, and the balance guard caps the payout at verified inflows.
   *
   * @param app The campaign application.
   * @param backer The backer to pay.
   * @param amount The amount to pay, in microAlgos.
   */
  @abimethod()
  payBack(app: Application, backer: Account, amount: uint64): void {
    this.assertCampaignCaller(app)
    assert(amount > Uint64(0), 'nothing to pay back')

    const box = this.readBox(app.id)
    assert(box.slice(VAULT_BOX_STATUS_OFFSET, VAULT_BOX_SETTLED_AT_OFFSET) === BOX_OPEN, 'campaign is not open')
    const paidIn: uint64 = op.btoi(box.slice(VAULT_BOX_PAID_IN_OFFSET, VAULT_BOX_PAID_OUT_OFFSET))
    const paidOut: uint64 = op.btoi(box.slice(VAULT_BOX_PAID_OUT_OFFSET, VAULT_BOX_ROOT_OFFSET))
    assert(amount <= paidIn - paidOut, 'insufficient campaign balance')

    this.campaignBox(app.id).value = this.packBox(
      paidIn,
      paidOut + amount,
      box.slice(VAULT_BOX_ROOT_OFFSET, VAULT_BOX_N_OFFSET),
      op.btoi(box.slice(VAULT_BOX_N_OFFSET, VAULT_BOX_STATUS_OFFSET)),
      BOX_OPEN,
      op.btoi(box.slice(VAULT_BOX_SETTLED_AT_OFFSET, VAULT_BOX_BYTES)),
    )

    itxn
      .payment({
        receiver: backer,
        amount: amount,
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Pay the campaign's creator on a successful claim: the payout is derived as `paidIn − paidOut`, never caller-supplied, and the box flips to Claimed.
   *
   * @param app The campaign application.
   */
  @abimethod()
  payClaim(app: Application): void {
    this.assertCampaignCaller(app)

    const box = this.readBox(app.id)
    assert(box.slice(VAULT_BOX_STATUS_OFFSET, VAULT_BOX_SETTLED_AT_OFFSET) === BOX_OPEN, 'campaign is not open')
    const paidIn: uint64 = op.btoi(box.slice(VAULT_BOX_PAID_IN_OFFSET, VAULT_BOX_PAID_OUT_OFFSET))
    const paidOut: uint64 = op.btoi(box.slice(VAULT_BOX_PAID_OUT_OFFSET, VAULT_BOX_ROOT_OFFSET))
    const payout: uint64 = paidIn - paidOut
    assert(payout > Uint64(0), 'nothing to claim')

    this.campaignBox(app.id).value = this.packBox(
      paidIn,
      paidOut + payout,
      box.slice(VAULT_BOX_ROOT_OFFSET, VAULT_BOX_N_OFFSET),
      op.btoi(box.slice(VAULT_BOX_N_OFFSET, VAULT_BOX_STATUS_OFFSET)),
      BOX_CLAIMED,
      op.btoi(box.slice(VAULT_BOX_SETTLED_AT_OFFSET, VAULT_BOX_BYTES)),
    )

    itxn
      .payment({
        receiver: app.creator,
        amount: payout,
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Record a failed campaign's settlement: store the final root/N (proofs verify against it after deletion) and flip Open to Failed, so later refunds flow through `refund()`.
   *
   * @param app The campaign application.
   * @param root The campaign's final tree root.
   * @param n The campaign's final position count.
   */
  @abimethod()
  settle(app: Application, root: bytes, n: uint64): void {
    if (!this.campaignBox(app.id).exists) {
      return
    }
    this.assertCampaignCaller(app)
    assert(root.length === Uint64(32), 'bad root length')

    const box = this.readBox(app.id)
    const status = box.slice(VAULT_BOX_STATUS_OFFSET, VAULT_BOX_SETTLED_AT_OFFSET)
    if (status === BOX_OPEN) {
      // 2^19 - 1: a cap-saturated campaign that missed its goal is failed in fact.
      assert(n <= Uint64(MAX_TREE_SIZE), 'n above maximum')
      this.campaignBox(app.id).value = this.packBox(
        op.btoi(box.slice(VAULT_BOX_PAID_IN_OFFSET, VAULT_BOX_PAID_OUT_OFFSET)),
        op.btoi(box.slice(VAULT_BOX_PAID_OUT_OFFSET, VAULT_BOX_ROOT_OFFSET)),
        root,
        n,
        BOX_FAILED,
        Global.latestTimestamp,
      )
    } else {
      assert(status === BOX_FAILED, 'already claimed')
    }
  }

  /**
   * Settle a failed campaign permissionlessly (the "creator vanished" case) while its app still exists; refunds then flow through `refund()`.
   *
   * @param app The failed campaign application.
   */
  @abimethod()
  settleOpen(app: Application): void {
    assert(Global.callerApplicationId === Uint64(0), 'must be called from the top level')
    const box = this.readBox(app.id)
    assert(box.slice(VAULT_BOX_STATUS_OFFSET, VAULT_BOX_SETTLED_AT_OFFSET) === BOX_OPEN, 'campaign is not open')

    // The campaign app still exists here, so its global state is readable (this is never attempted after deletion).
    /* v8 ignore start - every created campaign writes all seven globals, so these missing-key branches are defensive only; the guards run offline and the whole path on LocalNet. */
    const statusState = op.AppGlobal.getExUint64(app, Bytes('status'))
    const raisedState = op.AppGlobal.getExUint64(app, Bytes('raised'))
    const goalState = op.AppGlobal.getExUint64(app, Bytes('goal'))
    const deadlineState = op.AppGlobal.getExUint64(app, Bytes('deadline'))
    const rootState = op.AppGlobal.getExBytes(app, Bytes('root'))
    const nState = op.AppGlobal.getExUint64(app, Bytes('n'))
    const vaultState = op.AppGlobal.getExUint64(app, Bytes('vault'))
    assert(
      statusState[1] && raisedState[1] && goalState[1] && deadlineState[1] && rootState[1] && nState[1] && vaultState[1],
      'campaign state missing',
    )
    /* v8 ignore stop */
    assert(vaultState[0] === Global.currentApplicationId.id, 'campaign vault mismatch')
    assert(rootState[0].length === Uint64(32), 'bad root length')
    assert(statusState[0] <= Uint64(CAMPAIGN_STATUS_CLAIMED), 'invalid campaign status')
    assert(statusState[0] !== Uint64(CAMPAIGN_STATUS_CLAIMED), 'campaign already claimed')
    // 2^19 - 1: settle a cap-saturated campaign before its deadline.
    assert(nState[0] <= Uint64(MAX_TREE_SIZE), 'n above maximum')
    assert(Global.latestTimestamp >= deadlineState[0] || nState[0] >= Uint64(MAX_TREE_SIZE), 'deadline has not passed')
    assert(raisedState[0] < goalState[0], 'goal was reached')

    this.campaignBox(app.id).value = this.packBox(
      op.btoi(box.slice(VAULT_BOX_PAID_IN_OFFSET, VAULT_BOX_PAID_OUT_OFFSET)),
      op.btoi(box.slice(VAULT_BOX_PAID_OUT_OFFSET, VAULT_BOX_ROOT_OFFSET)),
      rootState[0],
      nState[0],
      BOX_FAILED,
      Global.latestTimestamp,
    )
  }

  /**
   * Refund one pledge of a settled-failed campaign directly, after deletion too: the proof is rebuilt from caller + proof, a replay reconstructs a different root, and only the refund window applies.
   *
   * @param app The settled-failed campaign application.
   * @param k Leaf position to null.
   * @param amount Pledged amount committed by the leaf.
   * @param txid The pledge payment's transaction ID, committed in the leaf at pledge time.
   * @param path The auth path as one blob: siblings (32·r) ‖ top (32·e) ‖ lower (32·c).
   */
  @abimethod()
  refund(app: Application, k: uint64, amount: uint64, txid: bytes, path: bytes): void {
    assert(Global.callerApplicationId === Uint64(0), 'must be called from the top level')
    assert(amount > Uint64(0), 'refund must be greater than zero')
    assert(txid.length === Uint64(32), 'bad txid length')

    const box = this.readBox(app.id)
    assert(box.slice(VAULT_BOX_STATUS_OFFSET, VAULT_BOX_SETTLED_AT_OFFSET) === BOX_FAILED, 'campaign is not refundable')
    const paidIn: uint64 = op.btoi(box.slice(VAULT_BOX_PAID_IN_OFFSET, VAULT_BOX_PAID_OUT_OFFSET))
    const paidOut: uint64 = op.btoi(box.slice(VAULT_BOX_PAID_OUT_OFFSET, VAULT_BOX_ROOT_OFFSET))
    const n: uint64 = op.btoi(box.slice(VAULT_BOX_N_OFFSET, VAULT_BOX_STATUS_OFFSET))
    const settledAt: uint64 = op.btoi(box.slice(VAULT_BOX_SETTLED_AT_OFFSET, VAULT_BOX_BYTES))
    assert(Global.latestTimestamp <= settledAt + this.refundWindow.value, 'refund window closed')
    assert(k < n, 'unknown position')

    // Reserve the whole refund from the blob length before pathLen/popcount can exhaust the 700-op base budget; the length is validated below.
    ensureBudget(op.shr(path.length, Uint64(5)) * Uint64(SPEND_ELEMENT_COST) + Uint64(SPEND_BASE_COST), OpUpFeeSource.GroupCredit)

    // Derive the expected path shape from (n, k) and reject a mis-sized blob.
    const r = this.pathLen(n, k)
    const c = this.popcount(n - op.shl(op.shr(n, r), r))
    const hasTop = op.shr(n, r + Uint64(1)) > Uint64(0)
    let h: uint64 = r + c
    if (hasTop) {
      h = h + Uint64(1)
    }
    assert(path.length === h * Uint64(32), 'bad path length')

    const leaf = op.sha512_256(LEAF_DOMAIN.concat(Txn.sender.bytes).concat(op.itob(amount)).concat(txid))
    /* v8 ignore next - a SHA-512/256 preimage of zero is infeasible; defensive null-marker check. */
    assert(leaf !== this.zeroRoot(), 'leaf must not be zero')
    assert(
      this.combineBlob(leaf, k, path, r, c, hasTop) === box.slice(VAULT_BOX_ROOT_OFFSET, VAULT_BOX_N_OFFSET),
      'proof does not match root',
    )
    assert(amount <= paidIn - paidOut, 'insufficient campaign balance')

    this.campaignBox(app.id).value = this.packBox(
      paidIn,
      paidOut + amount,
      this.combineBlob(this.zeroRoot(), k, path, r, c, hasTop),
      n,
      BOX_FAILED,
      settledAt,
    )

    itxn
      .payment({
        receiver: Txn.sender,
        amount: amount,
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Release a claimed campaign's box O(1); requires it fully paid out, and a no-op when `releaseClaimed` already freed it.
   *
   * @param app The campaign application.
   */
  @abimethod()
  notifyDelete(app: Application): void {
    if (!this.campaignBox(app.id).exists) {
      return
    }
    this.assertCampaignCaller(app)
    this.deleteClaimedBox(app)
  }

  /**
   * Release a claimed campaign's box permissionlessly, so a creator who claims and never deletes cannot park the box MBR on the vault forever.
   *
   * @param app The claimed campaign application.
   */
  @abimethod()
  releaseClaimed(app: Application): void {
    assert(Global.callerApplicationId === Uint64(0), 'must be called from the top level')
    if (!this.campaignBox(app.id).exists) {
      return
    }
    this.deleteClaimedBox(app)
  }

  /**
   * Delete a Claimed box after asserting no campaign balance remains.
   *
   * @param app The campaign application.
   */
  private deleteClaimedBox(app: Application): void {
    const box = this.readBox(app.id)
    assert(box.slice(VAULT_BOX_STATUS_OFFSET, VAULT_BOX_SETTLED_AT_OFFSET) === BOX_CLAIMED, 'campaign not claimed')
    assert(
      op.btoi(box.slice(VAULT_BOX_PAID_IN_OFFSET, VAULT_BOX_PAID_OUT_OFFSET)) ===
        op.btoi(box.slice(VAULT_BOX_PAID_OUT_OFFSET, VAULT_BOX_ROOT_OFFSET)),
      'campaign balance outstanding',
    )

    this.campaignBox(app.id).delete()
  }

  /**
   * Sweep a settled-failed campaign's residual to the sweep target and release its box once the refund window closes or the box is fully paid out.
   *
   * @param app The settled-failed campaign application.
   */
  @abimethod()
  finalize(app: Application): void {
    assert(Global.callerApplicationId === Uint64(0), 'must be called from the top level')
    const box = this.readBox(app.id)
    assert(box.slice(VAULT_BOX_STATUS_OFFSET, VAULT_BOX_SETTLED_AT_OFFSET) === BOX_FAILED, 'campaign is not failed')
    const settledAt: uint64 = op.btoi(box.slice(VAULT_BOX_SETTLED_AT_OFFSET, VAULT_BOX_BYTES))
    const paidIn: uint64 = op.btoi(box.slice(VAULT_BOX_PAID_IN_OFFSET, VAULT_BOX_PAID_OUT_OFFSET))
    const paidOut: uint64 = op.btoi(box.slice(VAULT_BOX_PAID_OUT_OFFSET, VAULT_BOX_ROOT_OFFSET))
    assert(paidIn === paidOut || Global.latestTimestamp >= settledAt + this.refundWindow.value, 'refund window still open')

    const residual: uint64 = paidIn - paidOut
    if (residual > Uint64(0)) {
      itxn
        .payment({
          receiver: this.sweepTarget.value,
          amount: residual,
          fee: Uint64(0),
        })
        .submit()
    }

    this.campaignBox(app.id).delete()
  }

  /**
   * The campaign-driven methods' caller must be the campaign app's own account (unforgeable, distinct per app id), and its box must exist.
   *
   * @param app The campaign application.
   */
  private assertCampaignCaller(app: Application): void {
    assert(this.campaignBox(app.id).exists, 'unknown campaign')
    assert(Txn.sender === app.address, 'not the campaign app')
  }

  /**
   * Read a campaign's packed box, asserting it exists.
   *
   * @param appId The campaign application id.
   * @returns The 65-byte packed box.
   */
  private readBox(appId: uint64): bytes {
    const box = this.campaignBox(appId).get({ default: Bytes() })
    assert(box.length === Uint64(65), 'unknown campaign')
    return box
  }

  /**
   * Pack the vault box fields into the 65-byte value.
   *
   * @param paidIn Verified inflows, in microAlgos.
   * @param paidOut Outflows paid, in microAlgos.
   * @param root Tree root (or Z before settlement).
   * @param n Position count (0 before settlement).
   * @param status One status byte.
   * @param settledAt Settlement timestamp (0 before settlement).
   * @returns The packed box value.
   */
  private packBox(paidIn: uint64, paidOut: uint64, root: bytes, n: uint64, status: bytes, settledAt: uint64): bytes {
    return op.itob(paidIn).concat(op.itob(paidOut)).concat(root).concat(op.itob(n)).concat(status).concat(op.itob(settledAt))
  }

  /**
   * The consumed-leaf marker: 32 zero bytes.
   *
   * @returns Z.
   */
  private zeroRoot(): bytes {
    return Bytes.fromHex('0000000000000000000000000000000000000000000000000000000000000000')
  }

  /**
   * Hash two child nodes into their parent (SHA-512/256 - the AVM `sha512_256` opcode, *not* `sha256`).
   *
   * @param left Left child.
   * @param right Right child.
   * @returns The parent node.
   */
  private hashPair(left: bytes, right: bytes): bytes {
    return op.sha512_256(left.concat(right))
  }

  /**
   * Test the lowest bit with `op.shr`/`op.shl`: PuyaTs arithmetic covers `+ - *` and comparisons, while bitwise operators fall back to JS `number` semantics.
   *
   * @param n The value to test.
   * @returns True when `n` is odd.
   */
  private isOdd(n: uint64): boolean {
    return n !== op.shl(op.shr(n, Uint64(1)), Uint64(1))
  }

  /**
   * Count the set bits of N. Exits at the highest set bit, so the cost is O(log N), not O(64).
   *
   * @param n The value to count.
   * @returns The popcount.
   */
  private popcount(n: uint64): uint64 {
    let count: uint64 = Uint64(0)
    for (const i of urange(Uint64(64))) {
      const rest: uint64 = op.shr(n, i)
      if (rest === Uint64(0)) {
        return count
      }
      if (this.isOdd(rest)) {
        count = count + Uint64(1)
      }
    }
    /* v8 ignore next - reachable only for N = 2^64 − 1 (no early exit in 64 iterations); defensive cap. */
    return count
  }

  /**
   * Within-peak path length for position k at size N - the first level whose sibling block extends past N (cost O(r), not O(64)).
   *
   * @param n Tree size (positions ever appended).
   * @param k Leaf position.
   * @returns The within-peak path length r.
   */
  private pathLen(n: uint64, k: uint64): uint64 {
    let r: uint64 = Uint64(0)
    for (const l of urange(Uint64(64))) {
      const i = op.shr(k, l)
      let sib: uint64 = i + Uint64(1)
      if (this.isOdd(i)) {
        sib = i - Uint64(1)
      }
      if (op.shl(sib + Uint64(1), l) <= n) {
        r = r + Uint64(1)
      } else {
        return r
      }
    }
    /* v8 ignore next - reachable only for trees of depth 64 (no missing level); defensive cap. */
    return r
  }

  /**
   * Recombine a leaf value along its path into the root: within-peak siblings by direction bit, then H(top ‖ acc), then lower peaks descending.
   *
   * @param start The leaf value (genuine leaf to verify, Z to null).
   * @param k Leaf position.
   * @param siblings Within-peak sibling hashes, ascending level.
   * @param top Fold of higher peaks (empty when none).
   * @param lower Lower peaks, ascending level.
   * @param r Within-peak path length.
   * @param c Lower-peak count.
   * @param hasTop Whether a higher-peak fold is present.
   * @returns The recombined root.
   */
  private combinePath(start: bytes, k: uint64, siblings: bytes, top: bytes, lower: bytes, r: uint64, c: uint64, hasTop: boolean): bytes {
    let acc: bytes = start
    for (const l of urange(r)) {
      const sib = siblings.slice(l * Uint64(32), (l + Uint64(1)) * Uint64(32))
      if (!this.isOdd(op.shr(k, l))) {
        acc = this.hashPair(acc, sib)
      } else {
        acc = this.hashPair(sib, acc)
      }
    }
    if (hasTop) {
      acc = this.hashPair(top, acc)
    }
    for (const j of urange(c)) {
      const idx: uint64 = c - Uint64(1) - j
      acc = this.hashPair(acc, lower.slice(idx * Uint64(32), (idx + Uint64(1)) * Uint64(32)))
    }
    return acc
  }

  /**
   * Recombine along a single-blob path (`siblings ‖ top ‖ lower`), split at the derived cut points.
   *
   * @param start The leaf value (genuine leaf to verify, Z to null).
   * @param k Leaf position.
   * @param path The auth path blob.
   * @param r Within-peak path length.
   * @param c Lower-peak count.
   * @param hasTop Whether a higher-peak fold is present.
   * @returns The recombined root.
   */
  private combineBlob(start: bytes, k: uint64, path: bytes, r: uint64, c: uint64, hasTop: boolean): bytes {
    const cut1: uint64 = r * Uint64(32)
    let topLen: uint64 = Uint64(0)
    if (hasTop) {
      topLen = Uint64(32)
    }
    return this.combinePath(start, k, path.slice(Uint64(0), cut1), path.slice(cut1, cut1 + topLen), path.slice(cut1 + topLen), r, c, hasTop)
  }
}
