import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import {
  APP_ID_BYTES,
  CLAIM_EXTRA_INNERS,
  CREDIT_EXTRA_INNERS,
  DELETE_EXTRA_INNERS,
  REGISTER_DEPOSIT_MICRO_ALGOS,
  REGISTRY_BOX_PREFIX,
  UNREGISTER_EXTRA_INNERS,
  VAULT_BOX_BYTES,
  VAULT_BOX_PAID_IN_OFFSET,
  VAULT_BOX_PAID_OUT_OFFSET,
  VAULT_BOX_PREFIX,
  VAULT_BOX_SETTLED_AT_OFFSET,
  VAULT_BOX_STATUS_FAILED_HEX,
  VAULT_BOX_STATUS_OFFSET,
} from '@kasakame/constants'
import type { TransactionSigner, TransactionWithSigner } from 'algosdk'
import { getApplicationAddress, hexToBytes } from 'algosdk'
import { getSdkConfig, waitForIndexerCatchUp, waitForIndexerRound } from './chain.js'
import type { BackerLeaf, TreeState } from './claim-tree.js'
import {
  MAX_TREE_SIZE,
  clearTreeCache,
  frontierForPledge,
  loadTree,
  pathBlobForRefund,
  pledgeOpUpIterations,
  refundOpUpIterations,
} from './claim-tree.js'
import { CampaignClient, CampaignFactory } from './generated/CampaignClient.js'
import { ClaimsVaultClient } from './generated/ClaimsVaultClient.js'
import { RegistryClient } from './generated/RegistryClient.js'

/**
 * Write path: assembles + signs transactions through the generated `CampaignClient`, `ClaimsVaultClient`, and
 * `RegistryClient`, plus a manual composer for the two-app pledge group. Each helper takes the wallet's signer/address
 * so the wallet - never the app - holds the keys.
 *
 * The claim-tree design (see docs/campaign.md):
 *
 * - **Creation** chains create → registry.register. Nothing is funded: the escrow never holds funds.
 * - **Pledges** are one atomic group `[pay, campaign.pledge, vault.credit]` (the payment immediately before the pledge,
 *   the matching credit immediately after it and last - the contracts reject other shapes, and the vault rejects a
 *   credit whose preceding transaction is not that pledge); the caller supplies the frontier (rebuilt
 *   from the indexer right before submitting) and retries once on a stale-proof rejection.
 * - **Cancels/refunds** null one leaf per call (`vault.payBack` path while the campaign box is open, `vault.refund`
 *   directly once settled) with the path rebuilt fresh and one stale retry.
 * - **Claims** are paid by the vault from per-campaign balance guards; **delete** settles in O(1) on every path.
 * - There are no assets anywhere: no opt-ins, no balances, no close-outs.
 */

export interface WalletSession {
  address: string
  signer: TransactionSigner
}

/** Vault box settlement state for refund routing and the window banner. */
export interface VaultBoxView {
  paidIn: bigint
  paidOut: bigint
  /** 1 = Open, 2 = Failed, 3 = Claimed. */
  status: number
  /** Settlement timestamp (seconds, 0 before settlement). */
  settledAt: bigint
}

// Contract asserts for stale Merkle proofs (`campaign/contract.algo.ts`, `claimsvault/contract.algo.ts`): plain
// strings, but ours and stable - covered by contract tests when they change.
const STALE_PROOF_PATTERN = /stale or forged frontier|proof does not match root/i

/**
 * Whether a submission failed on a stale Merkle proof (a concurrent pledge/refund moved the root).
 *
 * @param error The failure from a chain submission.
 * @returns True when rebuilding proofs and retrying once is correct.
 */
export function isStaleProofError(error: unknown): boolean {
  return error instanceof Error && STALE_PROOF_PATTERN.test(error.message)
}

type TransactionComposer = ReturnType<AlgorandClient['newGroup']>

const VAULT_BOX_STATUS_FAILED = Number.parseInt(VAULT_BOX_STATUS_FAILED_HEX, 16)

// Fee headroom per call: the outer call covers its inners via fee pooling, so every extra inner transaction costs one
// more current minimum fee. The counts are group-shape facts; the price comes from SuggestedParams.minFee at runtime.

/**
 * Read the current minimum transaction fee. `AlgorandClient` caches suggested params, so this does not add a network
 * call per group.
 *
 * @param algorand The configured Algorand client.
 * @returns The minimum fee in microAlgos.
 */
async function minimumFee(algorand: AlgorandClient): Promise<bigint> {
  const { minFee } = await algorand.getSuggestedParams()
  return BigInt(minFee)
}

/**
 * Extra fee for a spend: the payout inner transactions for this path plus one minimum fee per OpUp iteration the
 * contract will request.
 *
 * @param tree Current tree (its length is N).
 * @param position Leaf position.
 * @param payoutInners 2 for the campaign path (`payBack` app call + payment), 1 for the vault path (payment).
 * @param minFee Current minimum transaction fee in microAlgos.
 * @returns The extra fee in microAlgos.
 */
function spendExtraFee(tree: TreeState, position: number, payoutInners: 1 | 2, minFee: bigint): bigint {
  const iterations = refundOpUpIterations(BigInt(tree.leaves.length), BigInt(position))
  return (BigInt(payoutInners) + BigInt(iterations)) * minFee
}

function campaignClientFor(appId: bigint, session: WalletSession): CampaignClient {
  const { algorand } = getSdkConfig()
  return new CampaignClient({
    algorand,
    appId,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}

function vaultClientFor(session: WalletSession): ClaimsVaultClient {
  const { algorand, vaultAppId } = getSdkConfig()
  return new ClaimsVaultClient({
    algorand,
    appId: vaultAppId,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}

function registryClientFor(session: WalletSession): RegistryClient {
  const { algorand, registryAppId } = getSdkConfig()
  return new RegistryClient({
    algorand,
    appId: registryAppId,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}

/**
 * The vault's campaign box reference (key prefix 'c' + 8-byte big-endian app id) - inner vault calls require it
 * declared on the outer transaction.
 *
 * @param appId The campaign application id.
 * @returns Box references for the vault app.
 */
function vaultBoxRef(appId: bigint): { appId: bigint; name: Uint8Array }[] {
  let remaining = appId
  const appIdBytes = new Uint8Array(APP_ID_BYTES)
  for (let i = APP_ID_BYTES - 1; i >= 0; i--) {
    appIdBytes[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return [{ appId: getSdkConfig().vaultAppId, name: new Uint8Array([VAULT_BOX_PREFIX.charCodeAt(0), ...appIdBytes]) }]
}

/**
 * The Registry's registration box for a campaign (prefix 'r' + 8-byte big-endian app id) - the inner `isRegistered`
 * check needs it.
 *
 * @param appId The campaign application id.
 * @returns Box references for the Registry app.
 */
function registrationBox(appId: bigint): { appId: bigint; name: Uint8Array }[] {
  let remaining = appId
  const appIdBytes = new Uint8Array(APP_ID_BYTES)
  for (let i = APP_ID_BYTES - 1; i >= 0; i--) {
    appIdBytes[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return [{ appId: getSdkConfig().registryAppId, name: new Uint8Array([REGISTRY_BOX_PREFIX.charCodeAt(0), ...appIdBytes]) }]
}

/**
 * The vault app's account address (where pledges go).
 *
 * @returns The vault's app account address.
 */
export function vaultAddress(): string {
  return getApplicationAddress(getSdkConfig().vaultAppId).toString()
}

/**
 * Read and unpack a campaign's vault box (fresh from algod - routing decisions must not use stale indexer state).
 *
 * @param appId Campaign application id.
 * @returns The unpacked box, or undefined when no box exists yet.
 */
export async function fetchVaultBox(appId: bigint): Promise<VaultBoxView | undefined> {
  const { algorand, vaultAppId } = getSdkConfig()
  const vaultClient = new ClaimsVaultClient({ algorand, appId: vaultAppId })
  let raw: Uint8Array
  try {
    raw = (await vaultClient.state.box.campaignBox.value(appId)) as Uint8Array
  } catch {
    return undefined
  }
  if (raw.length !== VAULT_BOX_BYTES) return undefined
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  return {
    paidIn: view.getBigUint64(VAULT_BOX_PAID_IN_OFFSET),
    paidOut: view.getBigUint64(VAULT_BOX_PAID_OUT_OFFSET),
    // The length check above guarantees the status byte exists; the fallback satisfies noUncheckedIndexedAccess.
    /* v8 ignore next */
    status: raw[VAULT_BOX_STATUS_OFFSET] ?? 0,
    settledAt: view.getBigUint64(VAULT_BOX_SETTLED_AT_OFFSET),
  }
}

/**
 * The vault's configured refund window (seconds), for the refund-window banner.
 *
 * @returns The window in seconds and the sweep target address.
 */
export async function fetchVaultConfig(): Promise<{ window: bigint; sweepTarget: string }> {
  const { algorand, vaultAppId } = getSdkConfig()
  const vaultClient = new ClaimsVaultClient({ algorand, appId: vaultAppId })
  const window = (await vaultClient.state.global.refundWindow()) as bigint
  const sweepTarget = (await vaultClient.state.global.sweepTarget()) as string
  return { window, sweepTarget }
}

/**
 * The refund window's end timestamp: settlement plus the vault's configured window. Refunds stay open until then;
 * afterwards `finalize` can sweep whatever is unclaimed (see docs/claim-tree-protocol.md).
 *
 * @param settledAt Settlement timestamp (seconds) from the vault box (`VaultBoxView.settledAt`).
 * @param window Refund window (seconds) from `fetchVaultConfig`.
 * @returns The window end as a UNIX timestamp (seconds).
 */
export function refundWindowEndsAt(settledAt: bigint, window: bigint): bigint {
  return settledAt + window
}

/**
 * Run a proof-carrying submission, rebuilding proofs once when the tree moved under us (concurrent pledge/refund
 * changed the root between our read and our submit). Anything else throws immediately.
 *
 * @param run Builds fresh proofs from a fresh tree, then submits. Called up to twice.
 * @returns The confirmed round, if exposed.
 */
async function submitWithFreshProof(run: () => Promise<bigint | undefined>): Promise<bigint | undefined> {
  try {
    clearTreeCache()
    return await run()
  } catch (error) {
    if (isStaleProofError(error)) {
      clearTreeCache()
      return await run()
    }
    throw error
  }
}

/**
 * Deploy a new campaign: create → register with the Registry. Nothing is funded - the v2 escrow never holds funds.
 *
 * @param session Wallet session holding the signer and address.
 * @param title Short campaign title (stored on-chain).
 * @param metadataUri URI of the off-chain campaign metadata.
 * @param goalMicroAlgos Funding target in microAlgos.
 * @param deadlineSeconds Deadline as a UNIX timestamp (seconds).
 * @returns The new app id and escrow address.
 */
export async function createCampaign(
  session: WalletSession,
  title: string,
  metadataUri: string,
  goalMicroAlgos: bigint,
  deadlineSeconds: bigint,
): Promise<{ appId: bigint; appAddress: string }> {
  const { algorand, registryAppId, vaultAppId } = getSdkConfig()
  const campaignFactory = new CampaignFactory({
    algorand,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })

  const sendResult = await campaignFactory.send.create.create({
    args: {
      vault: vaultAppId,
      title: new TextEncoder().encode(title),
      metadataUri: new TextEncoder().encode(metadataUri),
      goal: goalMicroAlgos,
      deadline: deadlineSeconds,
    },
    appReferences: [vaultAppId],
  })

  const appId = sendResult.result.appId

  // Register with the Registry (when configured) so the browse page treats the campaign as official. First-touch
  // credit verifies registration on-chain, so an unregistered campaign can never take pledges.
  if (registryAppId > 0n) {
    const registryClient = registryClientFor(session)
    await registryClient.send.register({
      args: {
        app: appId,
        payment: await algorand.createTransaction.payment({
          sender: session.address,
          receiver: registryClient.appAddress,
          amount: microAlgos(REGISTER_DEPOSIT_MICRO_ALGOS),
        }),
      },
      appReferences: [appId],
    })
  }

  // The generated create result doesn't expose the confirmation round, so wait for the indexer to catch up to algod's current tip.
  await waitForIndexerCatchUp()

  return { appId, appAddress: sendResult.result.appAddress.toString() }
}

/**
 * Build the pledge group without sending it: one atomic `[pay, campaign.pledge, vault.credit]` (payment immediately
 * before the pledge, matching credit immediately after it and last) with a freshly rebuilt frontier. Waits for the indexer to catch up before building proofs (a lagging indexer is the usual cause of stale
 * first attempts, each of which costs the user an approval plus burned fees).
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param amountMicroAlgos Pledge amount in microAlgos.
 * @returns The composer holding the group, ready to build or send.
 */
async function buildPledgeGroup(appId: bigint, session: WalletSession, amountMicroAlgos: bigint): Promise<TransactionComposer> {
  const { algorand, registryAppId, vaultAppId } = getSdkConfig()
  const minFee = await minimumFee(algorand)
  // The manual composer resolves signers by sender address - register the wallet signer for this address first.
  algorand.account.setSigner(session.address, session.signer)
  await waitForIndexerCatchUp()
  const tree = await loadTree(appId, vaultAppId, vaultAddress())
  const n = BigInt(tree.leaves.length)
  if (n >= MAX_TREE_SIZE) {
    throw new Error('campaign reached its maximum size; it can no longer accept pledges')
  }
  const campaignClient = campaignClientFor(appId, session)
  const vaultClient = vaultClientFor(session)
  const composer = algorand.send.newGroup()
  composer.addAppCallMethodCall(
    await campaignClient.params.pledge({
      args: {
        payment: await algorand.createTransaction.payment({
          sender: session.address,
          receiver: vaultAddress(),
          amount: microAlgos(amountMicroAlgos),
        }),
        frontier: frontierForPledge(tree),
      },
      sender: session.address,
      extraFee: microAlgos(BigInt(pledgeOpUpIterations(n)) * minFee),
    }),
  )
  composer.addAppCallMethodCall(
    await vaultClient.params.credit({
      args: { app: appId, amount: amountMicroAlgos },
      sender: session.address,
      // The first-touch registration check runs inside the vault; the campaign app is the pledge txn before this call.
      appReferences: [registryAppId],
      boxReferences: [...vaultBoxRef(appId), ...registrationBox(appId)],
      extraFee: microAlgos(CREDIT_EXTRA_INNERS * minFee),
    }),
  )
  return composer
}

/**
 * Build the pledge group without sending it. The transactions come back unsigned with the session signer attached, so
 * an external signer can inspect or replace it before submitting; `pledge` is the build-and-send wrapper.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param amountMicroAlgos Pledge amount in microAlgos.
 * @returns The unsigned group.
 */
export async function pledgeGroup(appId: bigint, session: WalletSession, amountMicroAlgos: bigint): Promise<TransactionWithSigner[]> {
  return (await buildPledgeGroup(appId, session, amountMicroAlgos)).build().then((built) => built.transactions)
}

/**
 * Pledge ALGO: build the group with `pledgeGroup` and send it. Retries once when a concurrent pledge moved the
 * frontier under us.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param amountMicroAlgos Pledge amount in microAlgos.
 */
export async function pledge(appId: bigint, session: WalletSession, amountMicroAlgos: bigint): Promise<void> {
  const attempt = async (): Promise<bigint | undefined> => {
    const composer = await buildPledgeGroup(appId, session, amountMicroAlgos)
    await composer.send()
    return undefined
  }

  await submitWithFreshProof(attempt)
  // Our own write superseded the cache: drop it so the UI reload below refetches.
  clearTreeCache()
  await waitForIndexerCatchUp()
}

/**
 * Withdraw one pledge before the deadline (backer, while the campaign is still open). Waits for the indexer to
 * catch up before rebuilding the path (see pledge), then retries once when a concurrent spend moved the root
 * under us.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 */
export async function cancelPledge(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<void> {
  const { algorand, vaultAppId } = getSdkConfig()
  // The AppClient drops defaultSigner when sender is passed explicitly (string vs Address identity check),
  // so register globally like pledge/delete do - otherwise this always throws "No signer found".
  algorand.account.setSigner(session.address, session.signer)
  const minFee = await minimumFee(algorand)
  const attempt = async (): Promise<bigint | undefined> => {
    await waitForIndexerCatchUp()
    const tree = await loadTree(appId, vaultAppId, vaultAddress())
    const client = campaignClientFor(appId, session)
    const result = await client.send.cancelPledge({
      args: {
        k: leaf.position,
        amount: leaf.amount,
        txid: hexToBytes(leaf.txidHex),
        path: pathBlobForRefund(tree, leaf.position),
      },
      sender: session.address,
      appReferences: [vaultAppId],
      boxReferences: vaultBoxRef(appId),
      extraFee: microAlgos(spendExtraFee(tree, leaf.position, 2, minFee)),
    })
    return result.confirmation.confirmedRound
  }

  const confirmedRound = await submitWithFreshProof(attempt)
  // Our own write superseded the cache: drop it so the UI reload below refetches.
  clearTreeCache()
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Build the refund group without sending it. Routes by the vault box (fresh from algod): an `Open`/missing box goes
 * through the campaign, a `Failed` box goes straight to `vault.refund` (covers post-settle and post-delete). Waits
 * for the indexer to catch up before rebuilding the path (see buildPledgeGroup).
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 * @returns The composer holding the group, ready to build or send.
 */
async function buildRefundGroup(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<TransactionComposer> {
  const { algorand, vaultAppId } = getSdkConfig()
  // Same signer registration as cancelPledge (see above): without it both the campaign and vault paths fail.
  algorand.account.setSigner(session.address, session.signer)
  const minFee = await minimumFee(algorand)
  await waitForIndexerCatchUp()
  const tree = await loadTree(appId, vaultAppId, vaultAddress())
  const path = pathBlobForRefund(tree, leaf.position)
  const txid = hexToBytes(leaf.txidHex)
  const composer = algorand.send.newGroup()
  const box = await fetchVaultBox(appId)
  if (box !== undefined && box.status === VAULT_BOX_STATUS_FAILED) {
    const vaultClient = vaultClientFor(session)
    composer.addAppCallMethodCall(
      await vaultClient.params.refund({
        args: { app: appId, k: leaf.position, amount: leaf.amount, txid, path },
        sender: session.address,
        boxReferences: vaultBoxRef(appId),
        extraFee: microAlgos(spendExtraFee(tree, leaf.position, 1, minFee)),
      }),
    )
  } else {
    const client = campaignClientFor(appId, session)
    composer.addAppCallMethodCall(
      await client.params.refund({
        args: { k: leaf.position, amount: leaf.amount, txid, path },
        sender: session.address,
        appReferences: [vaultAppId],
        boxReferences: vaultBoxRef(appId),
        extraFee: microAlgos(spendExtraFee(tree, leaf.position, 2, minFee)),
      }),
    )
  }
  return composer
}

/**
 * Build the refund group without sending it - unsigned transactions with the session signer attached, for external
 * signing or inspection. `refund` is the build-and-send wrapper.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 * @returns The unsigned group.
 */
export async function refundGroup(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<TransactionWithSigner[]> {
  return (await buildRefundGroup(appId, session, leaf)).build().then((built) => built.transactions)
}

/**
 * Refund one pledge after a failed campaign: build the group with `refundGroup` and send it. Retries once when a
 * concurrent spend moved the root under us.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 */
export async function refund(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<void> {
  const attempt = async (): Promise<bigint | undefined> => {
    const composer = await buildRefundGroup(appId, session, leaf)
    const result = await composer.send()
    return result.confirmations[0]?.confirmedRound
  }

  const confirmedRound = await submitWithFreshProof(attempt)
  // Our own write superseded the cache: drop it so the UI reload below refetches.
  clearTreeCache()
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Claim the campaign funds (creator only, after deadline, goal reached). The vault pays the derived live total.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function claim(appId: bigint, session: WalletSession): Promise<void> {
  const { algorand, vaultAppId } = getSdkConfig()
  // Same signer registration as pledge (see cancelPledge): without it the send always throws "No signer found".
  algorand.account.setSigner(session.address, session.signer)
  const minFee = await minimumFee(algorand)
  const client = campaignClientFor(appId, session)
  const result = await client.send.claim({
    args: [],
    appReferences: [vaultAppId],
    boxReferences: vaultBoxRef(appId),
    extraFee: microAlgos(CLAIM_EXTRA_INNERS * minFee),
  })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Delete a settled campaign (creator only): settles the vault on the failed path, closes the escrow to the creator,
 * and unregisters from the Registry (returning the registration deposit). One atomic group (one wallet approval):
 * unregister runs first so every app reference resolves while the campaign app still exists, and the Registry requires
 * its `delete()` to be the immediately following transaction. Atomicity makes the order irrelevant to the outcome.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function deleteCampaign(appId: bigint, session: WalletSession): Promise<void> {
  const { algorand, registryAppId, vaultAppId } = getSdkConfig()
  const minFee = await minimumFee(algorand)
  const client = campaignClientFor(appId, session)
  // The manual composer resolves signers by sender address - register the wallet signer for this address first.
  algorand.account.setSigner(session.address, session.signer)
  const composer = algorand.send.newGroup()
  if (registryAppId > 0n) {
    const registryClient = registryClientFor(session)
    composer.addAppCallMethodCall(
      await registryClient.params.unregister({
        args: { app: appId },
        sender: session.address,
        appReferences: [appId],
        extraFee: microAlgos(UNREGISTER_EXTRA_INNERS * minFee),
      }),
    )
  }
  composer.addAppCallMethodCall(
    await client.params.delete.delete({
      args: [],
      sender: session.address,
      appReferences: [vaultAppId],
      boxReferences: vaultBoxRef(appId),
      extraFee: microAlgos(DELETE_EXTRA_INNERS * minFee),
    }),
  )
  await composer.send()
  await waitForIndexerCatchUp()
}
