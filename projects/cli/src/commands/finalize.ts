import { fetchChainTimestamp, fetchVaultBox, fetchVaultConfig, finalize, refundWindowEndsAt } from '@kasakame/sdk'
import type { CliOptions } from '../args.js'
import { formatAlgo, formatDeadline } from './format.js'
import { requireAppId } from './lookup.js'
import { runVaultWrite, VAULT_BOX_STATUS_FAILED } from './vault.js'

/**
 * Finalize a settled-failed campaign permissionlessly: sweep the residual to the vault's sweep target and release the box once the refund window closes or the box is fully paid out.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runFinalize(options: CliOptions): Promise<number> {
  const appId = requireAppId(options, 'finalize')
  const box = await fetchVaultBox(appId)
  if (box === undefined) {
    throw new Error(`Campaign ${appId.toString()} has no vault box; it was already finalized or never funded`)
  }
  if (box.status !== VAULT_BOX_STATUS_FAILED) {
    throw new Error(`Campaign ${appId.toString()} is not settled as failed; there is nothing to finalize`)
  }

  const residual = box.paidIn - box.paidOut
  if (residual > 0n) {
    const window = await fetchVaultConfig()
    const refundWindowEnd = refundWindowEndsAt(box.settledAt, window.window)
    if ((await fetchChainTimestamp()) < refundWindowEnd) {
      throw new Error(
        `The refund window for campaign ${appId.toString()} is open until ${formatDeadline(refundWindowEnd)}; backers can still refund`,
      )
    }
  }

  return runVaultWrite(options, {
    announce: `finalize campaign ${appId.toString()}`,
    plan:
      residual > 0n
        ? `Would finalize campaign ${appId.toString()} and sweep ${formatAlgo(residual)} ALGO to the vault's sweep target.`
        : `Would finalize campaign ${appId.toString()} and release its vault box.`,
    submit: (wallet) => finalize(appId, wallet),
    report:
      residual > 0n
        ? `Swept ${formatAlgo(residual)} ALGO to the vault's sweep target and released the vault box for campaign ${appId.toString()}.`
        : `Released the vault box for campaign ${appId.toString()}; there was nothing left to sweep.`,
  })
}
