import type { Account, Application, bytes, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  BoxMap,
  Bytes,
  Contract,
  Global,
  GlobalState,
  OnCompleteAction,
  TransactionType,
  Txn,
  Uint64,
  abimethod,
  assert,
  gtxn,
  itxn,
  op,
} from '@algorandfoundation/algorand-typescript'
import {
  MAX_REFUND_WINDOW_SECONDS,
  MAX_TREE_SIZE,
  MIN_REFUND_WINDOW_SECONDS,
  REGISTER_DEPOSIT_MICRO_ALGOS,
} from '@kasakame/constants/source'

/**
 * Registry - the canonical, ownerless on-chain registry for kasakame campaigns.
 *
 * The Registry is **not** a shared escrow: every campaign keeps its own application account and its own funds. Its only job is
 * authenticity and registration - it verifies that a new `Campaign` app runs the official kasakame approval **and clear-state**
 * programs (by SHA-256 hash) and records `app id → creator`, so clients can tell official campaigns apart from arbitrary copies.
 *
 * The campaign and vault program hashes, the vault sweep target, and the vault refund window are fixed at `create`. There is no owner,
 * no timelock, and no post-deployment configuration. `bindVault`, `register`, and `unregister` are top-level only; `isRegistered` stays
 * inner-callable because the vault calls it during first-touch `credit`.
 *
 * Registration costs a small, refundable deposit (the registration box's minimum balance, ~0.019 ALGO), paid to the Registry account and
 * returned by `unregister()` in the same atomic group as the campaign's `delete()`. The Registry takes no part in pledging, refunding, or
 * cleanup - it is never a bottleneck and never performs per-backer operations.
 */

// Campaign status values (see campaign/contract.algo.ts): 0 = Open, 1 = Failed, 2 = Claimed.
const CAMPAIGN_OPEN = Uint64(0)
const CAMPAIGN_FAILED = Uint64(1)
const CAMPAIGN_CLAIMED = Uint64(2)

// ARC-4 selector for Campaign.delete()void; unregister must be followed by it in the same atomic group.
const CAMPAIGN_DELETE_SELECTOR = Bytes.fromHex('24378d3c')

export class Registry extends Contract {
  /** SHA-256 of the official Campaign approval program concatenated with its clear-state program; fixed at create. */
  campaignProgramHash = GlobalState<bytes>()

  /** SHA-256 of the official ClaimsVault approval program concatenated with its clear-state program; fixed at create. */
  vaultProgramHash = GlobalState<bytes>()

  /** The expected vault sweep target; `bindVault` checks the vault's global. */
  expectedSweepTarget = GlobalState<Account>()

  /** The expected vault refund window; `bindVault` checks the vault's global. */
  expectedRefundWindow = GlobalState<uint64>()

  /** The official ClaimsVault app id; 0 until `bindVault`. */
  vault = GlobalState<uint64>({ initialValue: 0 })

  /** Registered campaigns: app id → campaign creator. */
  registered = BoxMap<uint64, Account>({ keyPrefix: 'r' })

  /**
   * Deploy the Registry with the immutable platform bundle.
   *
   * The hashes are SHA-256 digests of `itob(approval.length) ‖ approval ‖ clear`, exactly what `register` and `bindVault` verify.
   * Passing them as arguments keeps the same Registry bytecode usable for different Campaign/Vault bundles.
   *
   * @param campaignProgramHash SHA-256 of the official Campaign approval + clear-state programs.
   * @param vaultProgramHash SHA-256 of the official ClaimsVault approval + clear-state programs.
   * @param expectedSweepTarget The vault's required sweep target.
   * @param expectedRefundWindow The vault's required refund window, in seconds.
   */
  @abimethod({ onCreate: 'require' })
  create(campaignProgramHash: bytes, vaultProgramHash: bytes, expectedSweepTarget: Account, expectedRefundWindow: uint64): void {
    assert(Global.callerApplicationId === Uint64(0), 'must be called from the top level')
    assert(Txn.applicationId.id === 0, 'must be called on app creation')
    assert(campaignProgramHash.length === Uint64(32), 'campaign program hash must be 32 bytes')
    assert(vaultProgramHash.length === Uint64(32), 'vault program hash must be 32 bytes')
    assert(expectedSweepTarget !== Global.zeroAddress, 'sweep target must not be zero')
    assert(expectedSweepTarget !== Global.currentApplicationAddress, 'sweep target must not be the registry')
    // Bind the vault window to the same range as ClaimsVault: 30 days to 10 years.
    assert(expectedRefundWindow >= Uint64(MIN_REFUND_WINDOW_SECONDS), 'refund window too short')
    assert(expectedRefundWindow <= Uint64(MAX_REFUND_WINDOW_SECONDS), 'refund window too long')

    this.campaignProgramHash.value = campaignProgramHash
    this.vaultProgramHash.value = vaultProgramHash
    this.expectedSweepTarget.value = expectedSweepTarget
    this.expectedRefundWindow.value = expectedRefundWindow
    this.vault.value = Uint64(0)
  }

  /**
   * Bind the official ClaimsVault, permissionlessly and once.
   *
   * The vault is deployed after the Registry because its `create` records the Registry id. This call verifies the back-pointer,
   * the vault's sweep target and refund window, and its approval + clear-state program hash. A clone with the same program and
   * the same configuration behaves identically and cannot steal funds; the deployer should bind its intended vault immediately.
   *
   * @param vault The official ClaimsVault application.
   */
  @abimethod()
  bindVault(vault: Application): void {
    assert(Global.callerApplicationId === Uint64(0), 'must be called from the top level')
    assert(this.vault.value === Uint64(0), 'vault already bound')
    assert(vault.id !== Uint64(0), 'vault required')
    assert(this.vaultProgramHash.value.length === Uint64(32), 'vault program hash not configured')

    const vaultRegistry = op.AppGlobal.getExUint64(vault, Bytes('registry'))
    assert(vaultRegistry[1] && vaultRegistry[0] === Global.currentApplicationId.id, 'vault is not bound to this registry')

    const vaultSweep = op.AppGlobal.getExBytes(vault, Bytes('sweepTarget'))
    assert(vaultSweep[1] && vaultSweep[0] === this.expectedSweepTarget.value.bytes, 'vault sweep target mismatch')

    const vaultWindow = op.AppGlobal.getExUint64(vault, Bytes('refundWindow'))
    assert(vaultWindow[1] && vaultWindow[0] === this.expectedRefundWindow.value, 'vault refund window mismatch')

    assert(
      op.sha256(op.itob(vault.approvalProgram.length).concat(vault.approvalProgram).concat(vault.clearStateProgram)) ===
        this.vaultProgramHash.value,
      'not the official vault program',
    )
    this.vault.value = vault.id
  }

  /**
   * Register a newly created Campaign app.
   *
   * Anyone may call, but only the campaign's creator can register it: the calling application's approval and clear-state programs
   * must hash to the official `campaignProgramHash`, its `vault` global must be the official `vault`, and its creator must be the
   * caller. The caller pays a refundable deposit covering the registration box's minimum balance; `unregister()` returns it when
   * the campaign is deleted.
   *
   * `register` must be the final transaction in the group. A payment can only appear once in one group, so this makes each
   * registration consume a distinct deposit: without it one payment could register several campaigns and drain the Registry's
   * minimum-balance buffer through repeated `unregister()` calls.
   *
   * @param app The deployed Campaign application (its approval + clear-state programs and vault are verified).
   * @param payment Payment from the caller to the Registry account, covering the registration deposit.
   */
  @abimethod()
  register(app: Application, payment: gtxn.PaymentTxn): void {
    assert(Global.callerApplicationId === Uint64(0), 'must be called from the top level')
    assert(Txn.groupIndex === Global.groupSize - Uint64(1), 'register must be the final transaction in the group')
    assert(this.campaignProgramHash.value.length === Uint64(32), 'official program hash not configured')
    assert(this.vault.value !== Uint64(0), 'official vault not configured')
    assert(app.creator === Txn.sender, 'only the campaign creator can register')
    assert(payment.sender === Txn.sender, 'payment must come from the caller')
    assert(payment.receiver === Global.currentApplicationAddress, 'payment must be made to the registry')
    // Registration box MBR: 2,500 + 400 × (name bytes + value bytes) = 2,500 + 400 × (9 + 32) µA.
    assert(payment.amount === Uint64(REGISTER_DEPOSIT_MICRO_ALGOS), 'registration deposit must be exact')
    assert(payment.closeRemainderTo === Global.zeroAddress, 'payment must not close')
    assert(payment.rekeyTo === Global.zeroAddress, 'payment must not rekey')
    assert(!this.registered(app.id).exists, 'campaign already registered')
    // Length-prefix the approval program so the hash binds the exact approval/clear split: `sha256(approval ‖ clear)`
    // alone is ambiguous, because moving bytes between the two programs leaves the concatenation unchanged.
    assert(
      op.sha256(op.itob(app.approvalProgram.length).concat(app.approvalProgram).concat(app.clearStateProgram)) ===
        this.campaignProgramHash.value,
      'not an official kasakame campaign',
    )
    const campaignVault = op.AppGlobal.getExUint64(app, Bytes('vault'))
    assert(campaignVault[1] && campaignVault[0] === this.vault.value, 'campaign vault is not the official vault')

    this.registered(app.id).value = Txn.sender
  }

  /**
   * Unregister a campaign and recover the registration deposit.
   *
   * Only the campaign creator may call. For a registered campaign the registration box is deleted (freeing its minimum
   * balance on the Registry account) and the deposit is paid back to the creator. The campaign app must still exist and be
   * settled (`Failed` or `Claimed`), pristine (`Open` with `raised == 0`), or failed-in-fact (`Open`, deadline passed,
   * `raised < goal`, or the tree cap reached with the goal missed). A live campaign with pledges cannot delist itself. An
   * unregistered campaign (for example, one whose registration never landed) is a no-op: the same cleanup group can delete it
   * without a deposit.
   *
   * Delisting and deletion are one atomic operation: the campaign's `delete()` must be the immediately following transaction,
   * from the same creator, with the `DeleteApplication` action. This lets zero-pledge and all-cancelled campaigns clean up
   * immediately while guaranteeing that no unregistered campaign can remain live to take pledges.
   *
   * @param app The Campaign application.
   */
  @abimethod()
  unregister(app: Application): void {
    assert(Global.callerApplicationId === Uint64(0), 'must be called from the top level')
    // The caller is the campaign creator whether or not the campaign is registered.
    assert(app.creator === Txn.sender, 'only the campaign creator can unregister')
    const registered = this.registered(app.id).exists
    if (registered) {
      assert(this.registered(app.id).value === Txn.sender, 'only the campaign creator can unregister')

      const status = op.AppGlobal.getExUint64(app, Bytes('status'))
      const deadline = op.AppGlobal.getExUint64(app, Bytes('deadline'))
      const raised = op.AppGlobal.getExUint64(app, Bytes('raised'))
      const goal = op.AppGlobal.getExUint64(app, Bytes('goal'))
      const n = op.AppGlobal.getExUint64(app, Bytes('n'))
      assert(status[1] && deadline[1] && raised[1] && goal[1] && n[1], 'campaign state missing')
      assert(status[0] <= CAMPAIGN_CLAIMED, 'invalid campaign status')

      const settled = status[0] === CAMPAIGN_FAILED || status[0] === CAMPAIGN_CLAIMED
      const pristine = status[0] === CAMPAIGN_OPEN && raised[0] === Uint64(0)
      const failedInFact =
        status[0] === CAMPAIGN_OPEN && (Global.latestTimestamp >= deadline[0] || n[0] >= Uint64(MAX_TREE_SIZE)) && raised[0] < goal[0]
      assert(settled || pristine || failedInFact, 'campaign is still live')
    }

    // The campaign's delete must be the very next transaction, so delisting and deletion are atomic. This also shapes the
    // no-op case: an unregistered campaign can only be cleaned up by the same [unregister, delete] group.
    const deleteIndex: uint64 = Txn.groupIndex + Uint64(1)
    assert(deleteIndex < Global.groupSize, 'delete must follow unregister')
    assert(gtxn.Transaction(deleteIndex).type === TransactionType.ApplicationCall, 'delete must follow unregister')
    const deleteCall = gtxn.ApplicationCallTxn(deleteIndex)
    assert(deleteCall.appId.id === app.id, 'delete must target the campaign')
    assert(deleteCall.sender === Txn.sender, 'delete must come from the creator')
    assert(deleteCall.onCompletion === OnCompleteAction.DeleteApplication, 'delete must be DeleteApplication')
    assert(deleteCall.numAppArgs === Uint64(1), 'delete args mismatch')
    assert(deleteCall.appArgs(Uint64(0)) === CAMPAIGN_DELETE_SELECTOR, 'delete selector mismatch')

    if (!registered) {
      return
    }

    this.registered(app.id).delete()

    itxn
      .payment({
        receiver: Txn.sender,
        amount: Uint64(REGISTER_DEPOSIT_MICRO_ALGOS),
        fee: Uint64(0),
      })
      .submit()
  }

  /**
   * Whether an application is registered as an official kasakame campaign.
   *
   * @param app The application to check.
   * @returns True when the app is registered.
   */
  @abimethod({ readonly: true })
  isRegistered(app: Application): boolean {
    return this.registered(app.id).exists
  }
}
