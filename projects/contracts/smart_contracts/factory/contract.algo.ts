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

/**
 * Factory - the canonical, on-chain registry for kasakame campaigns.
 *
 * The Factory is **not** a shared escrow: every campaign keeps its own application account and its own funds. The Factory's only job is
 * authenticity and registration - it verifies that a new `Campaign` app runs the official kasakame approval **and clear-state**
 * programs (by SHA-256 hash) and records `app id → creator`, so the frontend can tell official campaigns apart from arbitrary copies
 * of the contract.
 *
 * Registration costs a small, refundable deposit (the registration box's minimum balance, ~0.019 ALGO), paid to the Factory account and
 * returned by `unregister()` in the same atomic group as the campaign's `delete()`. The Factory takes no part in pledging, refunding, or
 * cleanup - it is never a bottleneck and never performs per-backer operations.
 */

// Minimum balance of one registration box: 2,500 + 400 × (name bytes + value bytes) = 2,500 + 400 × (9 + 32) µA.
const REGISTER_MBR = 18_900

// Campaign status values (see campaign/contract.algo.ts): 0 = Open, 1 = Failed, 2 = Claimed.
const CAMPAIGN_OPEN = Uint64(0)
const CAMPAIGN_FAILED = Uint64(1)
const CAMPAIGN_CLAIMED = Uint64(2)

// ARC-4 selector for Campaign.delete()void; unregister must be followed by it in the same atomic group.
const CAMPAIGN_DELETE_SELECTOR = Bytes.fromHex('24378d3c')

export class Factory extends Contract {
  /** The platform owner - the only account allowed to configure the official program hash and vault. */
  owner = GlobalState<Account>()

  /** SHA-256 of the official Campaign approval program concatenated with its clear-state program; set by the owner. */
  approvalHash = GlobalState<bytes>()

  /** The official ClaimsVault app id; set once by the owner after the vault is deployed. 0 until configured. */
  vault = GlobalState<uint64>({ initialValue: 0 })

  /** Registered campaigns: app id → campaign creator. */
  registered = BoxMap<uint64, Account>({ keyPrefix: 'r' })

  /**
   * Deploy the Factory.
   *
   * The platform funds the Factory's application account (at least the 0.1 ALGO account base) after creation, so it can hold the
   * registration deposits and pay them back on `unregister()`.
   */
  @abimethod({ onCreate: 'require' })
  create(): void {
    assert(Txn.applicationId.id === 0, 'must be called on app creation')
    this.owner.value = Txn.sender
    this.approvalHash.value = Bytes()
  }

  /**
   * Set the official Campaign program hash.
   *
   * Owner only. Registration is refused until this is configured. The SHA-256 digest covers the approval program **and** the
   * clear-state program, so a copy with a custom clear program cannot be registered. Updating the hash (e.g. after a contract
   * upgrade) makes old program versions unregisterable while existing registrations stay. The method name is historical; the
   * stored value is the program hash over both programs.
   *
   * @param hash The SHA-256 digest of the official Campaign approval + clear-state programs.
   */
  @abimethod()
  setApprovalHash(hash: bytes): void {
    assert(Txn.sender === this.owner.value, 'only the owner can set the program hash')
    assert(hash.length === 32, 'program hash must be 32 bytes')
    this.approvalHash.value = hash
  }

  /**
   * Bind the official ClaimsVault to this Factory.
   *
   * Owner only, once. The Factory is deployed before the vault (the vault's `create` records the Factory id), so this is
   * set after the vault exists. The vault must point back at this Factory, so a wrong or foreign vault cannot be bound
   * permanently. `register` then rejects campaigns whose `vault` global differs.
   *
   * @param vault The official ClaimsVault application.
   */
  @abimethod()
  setVault(vault: Application): void {
    assert(Txn.sender === this.owner.value, 'only the owner can set the vault')
    assert(this.vault.value === Uint64(0), 'vault already set')
    const vaultFactory = op.AppGlobal.getExUint64(vault, Bytes('factory'))
    assert(vaultFactory[1] && vaultFactory[0] === Global.currentApplicationId.id, 'vault is not bound to this factory')
    this.vault.value = vault.id
  }

  /**
   * Register a newly created Campaign app.
   *
   * Anyone may call, but only the campaign's creator can register it: the calling application's approval and clear-state programs
   * must hash to the official `approvalHash`, its `vault` global must be the official `vault`, and its creator must be the caller.
   * The caller pays a refundable deposit covering the registration box's minimum balance; `unregister()` returns it when the
   * campaign is deleted.
   *
   * `register` must be the final transaction in the group. A payment can only appear once in one group, so this makes each
   * registration consume a distinct deposit: without it one payment could register several campaigns and drain the Factory's
   * minimum-balance buffer through repeated `unregister()` calls.
   *
   * @param app The deployed Campaign application (its approval + clear-state programs and vault are verified).
   * @param payment Payment from the caller to the Factory account, covering the registration deposit.
   */
  @abimethod()
  register(app: Application, payment: gtxn.PaymentTxn): void {
    assert(Txn.groupIndex === Global.groupSize - Uint64(1), 'register must be the final transaction in the group')
    assert(this.approvalHash.value.length === 32, 'official program hash not configured')
    assert(this.vault.value !== Uint64(0), 'official vault not configured')
    assert(app.creator === Txn.sender, 'only the campaign creator can register')
    assert(payment.sender === Txn.sender, 'payment must come from the caller')
    assert(payment.receiver === Global.currentApplicationAddress, 'payment must be made to the factory')
    assert(payment.amount >= REGISTER_MBR, 'registration deposit too small')
    assert(payment.closeRemainderTo === Global.zeroAddress, 'payment must not close')
    assert(payment.rekeyTo === Global.zeroAddress, 'payment must not rekey')
    assert(!this.registered(app.id).exists, 'campaign already registered')
    // Length-prefix the approval program so the hash binds the exact approval/clear split: `sha256(approval ‖ clear)`
    // alone is ambiguous, because moving bytes between the two programs leaves the concatenation unchanged.
    assert(
      op.sha256(op.itob(app.approvalProgram.length).concat(app.approvalProgram).concat(app.clearStateProgram)) === this.approvalHash.value,
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
   * balance on the Factory account) and the deposit is paid back to the creator. The campaign app must still exist and be
   * settled (`Failed` or `Claimed`), pristine (`Open` with `raised == 0`), or failed-in-fact (`Open`, deadline passed,
   * `raised < goal`). A live campaign with pledges cannot delist itself. An unregistered campaign (for example, one whose
   * registration never landed) is a no-op: the same cleanup group can delete it without a deposit.
   *
   * Delisting and deletion are one atomic operation: the campaign's `delete()` must be the immediately following
   * transaction, from the same creator, with the `DeleteApplication` action. This lets zero-pledge and all-cancelled
   * campaigns clean up immediately while guaranteeing that no unregistered campaign can remain live to take pledges.
   *
   * @param app The Campaign application.
   */
  @abimethod()
  unregister(app: Application): void {
    // The caller is the campaign creator whether or not the campaign is registered.
    assert(app.creator === Txn.sender, 'only the campaign creator can unregister')
    const registered = this.registered(app.id).exists
    if (registered) {
      assert(this.registered(app.id).value === Txn.sender, 'only the campaign creator can unregister')

      const status = op.AppGlobal.getExUint64(app, Bytes('status'))
      const deadline = op.AppGlobal.getExUint64(app, Bytes('deadline'))
      const raised = op.AppGlobal.getExUint64(app, Bytes('raised'))
      const goal = op.AppGlobal.getExUint64(app, Bytes('goal'))
      assert(status[1] && deadline[1] && raised[1] && goal[1], 'campaign state missing')

      const settled = status[0] === CAMPAIGN_FAILED || status[0] === CAMPAIGN_CLAIMED
      const pristine = status[0] === CAMPAIGN_OPEN && raised[0] === Uint64(0)
      const failedInFact = status[0] === CAMPAIGN_OPEN && Global.latestTimestamp >= deadline[0] && raised[0] < goal[0]
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
        amount: REGISTER_MBR,
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
