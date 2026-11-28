import { microAlgos } from '@algorandfoundation/algokit-utils'
import { getSdkConfig } from '../runtime/config.js'
import { waitForIndexerCatchUpBestEffort } from '../runtime/indexer.js'
import type { WalletSession } from './clients.js'
import { vaultClientFor } from './clients.js'
import type { WriteConfirmation } from './confirmation.js'
import { writeConfirmation } from './confirmation.js'
import { logWriteConfirmed, submitWithClassification } from './errors.js'
import { minimumFee } from './fees.js'
import { fetchVaultBox, vaultBoxRef } from './vault.js'

/**
 * Settle a failed campaign permissionlessly when the creator is gone; the vault reads the campaign's live global state, so the app must still exist.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @returns The confirmed transaction ids, round, and app id.
 */
export async function settleOpen(appId: bigint, session: WalletSession): Promise<WriteConfirmation> {
  const { algorand } = getSdkConfig()
  // The AppClient compares the raw sender string, so the supplied signer is otherwise dropped.
  algorand.account.setSigner(session.address, session.signer)
  const vaultClient = vaultClientFor(session)
  const result = await submitWithClassification(
    'settleOpen',
    () =>
      vaultClient.send.settleOpen({
        args: { app: appId },
        sender: session.address,
        appReferences: [appId],
        boxReferences: vaultBoxRef(appId),
      }),
    appId,
  )
  await waitForIndexerCatchUpBestEffort()
  const confirmation = writeConfirmation(result, { appId })
  logWriteConfirmed('settleOpen', appId, confirmation)
  return confirmation
}

/**
 * Release a claimed campaign's vault box permissionlessly, recovering its minimum balance to the vault; requires a Claimed box with no outstanding balance, and a missing box is a no-op.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @returns The confirmed transaction ids, round, and app id.
 */
export async function releaseClaimed(appId: bigint, session: WalletSession): Promise<WriteConfirmation> {
  const { algorand } = getSdkConfig()
  // Same signer registration as claim: the generated client drops its default signer for an explicit sender.
  algorand.account.setSigner(session.address, session.signer)
  const vaultClient = vaultClientFor(session)
  const result = await submitWithClassification(
    'releaseClaimed',
    () =>
      vaultClient.send.releaseClaimed({
        args: { app: appId },
        sender: session.address,
        appReferences: [appId],
        boxReferences: vaultBoxRef(appId),
      }),
    appId,
  )
  await waitForIndexerCatchUpBestEffort()
  const confirmation = writeConfirmation(result, { appId })
  logWriteConfirmed('releaseClaimed', appId, confirmation)
  return confirmation
}

/**
 * Sweep a settled-failed campaign's residual to the sweep target and release its box once the refund window closes or the box is fully paid out; permissionless.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @returns The confirmed transaction ids, round, app id, and swept residual.
 */
export async function finalize(appId: bigint, session: WalletSession): Promise<WriteConfirmation> {
  const { algorand } = getSdkConfig()
  const minFee = await minimumFee(algorand)
  const box = await fetchVaultBox(appId)
  // The residual payment is the only inner transaction; skip its fee when the box is fully paid out or missing.
  const extraInners = box !== undefined && box.paidIn > box.paidOut ? 1n : 0n
  // The signer must be registered before the generated client resolves it by sender.
  algorand.account.setSigner(session.address, session.signer)
  const vaultClient = vaultClientFor(session)
  const result = await submitWithClassification(
    'finalize',
    () =>
      vaultClient.send.finalize({
        args: { app: appId },
        sender: session.address,
        appReferences: [appId],
        boxReferences: vaultBoxRef(appId),
        extraFee: microAlgos(extraInners * minFee),
      }),
    appId,
  )
  await waitForIndexerCatchUpBestEffort()
  const confirmation = writeConfirmation(result, { appId, amount: box === undefined ? 0n : box.paidIn - box.paidOut })
  logWriteConfirmed('finalize', appId, confirmation)
  return confirmation
}
