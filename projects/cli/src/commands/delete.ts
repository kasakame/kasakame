import { deleteCampaign, fetchChainTimestamp, getCampaignStatus } from '@kasakame/sdk'
import type { CliOptions } from '../app/options.js'
import { withSession } from '../auth/open-session.js'
import { announceSubmit, printConfirmation } from './shared/format.js'
import { campaignHeader, requireAppId } from './shared/lookup.js'

/**
 * Delete a campaign for its creator; backers of a failed campaign keep refunding from the vault after the deletion.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runDelete(options: CliOptions): Promise<number> {
  const appId = requireAppId(options, 'delete')
  const header = await campaignHeader(appId, options.network)
  if (header.deleted) {
    throw new Error(`Campaign ${appId.toString()} was already deleted`)
  }
  const status = getCampaignStatus(header, await fetchChainTimestamp())
  if (status === 'successful' && header.status !== 'claimed') {
    throw new Error(`Campaign ${appId.toString()} reached its goal; claim it before deleting`)
  }
  if (status === 'open' && header.raisedMicroAlgos > 0n) {
    throw new Error(`Campaign ${appId.toString()} is still open with live pledges; cancel them or wait for the deadline`)
  }

  return withSession(options, async (wallet) => {
    if (header.creator !== wallet.address) {
      throw new Error(`Campaign ${appId.toString()} was created by ${header.creator}; only the creator can delete it`)
    }
    if (options.dryRun) {
      console.log(`Would delete campaign ${appId.toString()} as ${wallet.address}.`)
      console.log('Dry run: nothing submitted.')
      return 0
    }

    announceSubmit(options, `delete campaign ${appId.toString()}`)
    const confirmation = await deleteCampaign(appId, wallet)
    console.log(`Deleted campaign ${appId.toString()}.`)
    printConfirmation(confirmation, options.network)
    if (status === 'failed' && header.raisedMicroAlgos > 0n) {
      console.log('Backers keep refunding from the vault until the refund window closes.')
    }
    console.log("The campaign's schema MBR and any Registry registration deposit are back in your account.")
    return 0
  })
}
