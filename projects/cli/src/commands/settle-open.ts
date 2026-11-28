import { fetchChainTimestamp, fetchVaultBox, getCampaignStatus, settleOpen } from '@kasakame/sdk'
import type { CommandContext } from '../app/context.js'
import { campaignHeader, requireAppId } from './shared/lookup.js'
import { runVaultWrite, VAULT_BOX_STATUS_FAILED, VAULT_BOX_STATUS_OPEN } from './shared/vault.js'

/**
 * Settle a failed campaign permissionlessly when its creator is gone, so backers refund through the vault; the campaign app must still exist.
 *
 * @param context Parsed command context.
 * @returns Process exit code.
 */
export async function runSettleOpen(context: CommandContext): Promise<number> {
  const { options } = context
  const appId = requireAppId(options, 'settle-open')
  const header = await campaignHeader(appId, options.network)
  if (header.deleted) {
    throw new Error(`Campaign ${appId.toString()} was already deleted; deleting a failed campaign settles its vault box`)
  }
  if (getCampaignStatus(header, await fetchChainTimestamp()) === 'successful') {
    throw new Error(`Campaign ${appId.toString()} reached its goal; there is nothing to settle`)
  }
  const box = await fetchVaultBox(appId)
  if (box === undefined) {
    throw new Error(`Campaign ${appId.toString()} has no vault box; there is nothing to settle`)
  }
  if (box.status === VAULT_BOX_STATUS_FAILED) {
    throw new Error(`Campaign ${appId.toString()} is already settled; backers can refund it`)
  }
  if (box.status !== VAULT_BOX_STATUS_OPEN) {
    throw new Error(`Campaign ${appId.toString()} was not failed; there is nothing to settle`)
  }

  return runVaultWrite(context, {
    announce: `settle open campaign ${appId.toString()}`,
    plan: `Would settle campaign ${appId.toString()} as failed.`,
    submit: (wallet) => settleOpen(appId, wallet),
    report: `Settled campaign ${appId.toString()} as failed; backers can now refund through the vault.`,
  })
}
