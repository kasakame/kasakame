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
  CAMPAIGN_STATUS_CLAIMED,
  CAMPAIGN_STATUS_FAILED,
  CAMPAIGN_STATUS_OPEN,
  MAX_REFUND_WINDOW_SECONDS,
  MAX_TREE_SIZE,
  MIN_REFUND_WINDOW_SECONDS,
  REGISTER_DEPOSIT_MICRO_ALGOS,
  REGISTRY_BOX_PREFIX,
} from '@kasakame/constants/source'

/**
 * Registry - the canonical, ownerless on-chain registry for kasakame campaigns: it verifies the official program hashes and records `app id → creator` (see docs/claim-tree-protocol.md).
 */

// Campaign status values (see campaign/contract.algo.ts): 0 = Open, 1 = Failed, 2 = Claimed.
const CAMPAIGN_OPEN = Uint64(CAMPAIGN_STATUS_OPEN)
const CAMPAIGN_FAILED = Uint64(CAMPAIGN_STATUS_FAILED)
const CAMPAIGN_CLAIMED = Uint64(CAMPAIGN_STATUS_CLAIMED)

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
  registered = BoxMap<uint64, Account>({ keyPrefix: REGISTRY_BOX_PREFIX })

  /**
   * Deploy the Registry with the immutable platform bundle: hashes of `itob(approval.length) ‖ approval ‖ clear`, the same form `register` and `bindVault` verify.
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
   * Bind the official ClaimsVault, permissionlessly and once; the vault is deployed after the Registry because its `create` records the Registry id.
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
   * Register a newly created Campaign app: the caller must be its creator and pays a refundable deposit, and the app's programs and `vault` global must match the official bundle. It must be the group's final transaction so one payment backs one registration.
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
    // Length-prefix the approval program so the hash binds the exact approval/clear split: `sha256(approval ‖ clear)` alone is ambiguous.
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
   * Unregister a campaign and recover the deposit (creator only): the campaign must be settled, pristine, or failed in fact, and its `delete()` must be the very next transaction so delisting and deletion are atomic.
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

    // The campaign's delete must be the very next transaction, so delisting and deletion are atomic; this also shapes the unregistered no-op case.
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
