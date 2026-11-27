import { deleteCampaign, fetchChainTimestamp, getCampaignStatus } from '@kasakame/sdk'
import type { CliOptions } from '../args.js'
import { openCliSession } from '../session.js'
import { announceSubmit, printConfirmation } from './format.js'
import { campaignHeader, requireAppId } from './lookup.js'

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

  const session = await openCliSession(options)
  try {
    if (header.creator !== session.wallet.address) {
      throw new Error(`Campaign ${appId.toString()} was created by ${header.creator}; only the creator can delete it`)
    }
    if (options.dryRun) {
      console.log(`Would delete campaign ${appId.toString()} as ${session.wallet.address}.`)
      console.log('Dry run: nothing submitted.')
      return 0
    }

    announceSubmit(options, `delete campaign ${appId.toString()}`)
    const confirmation = await deleteCampaign(appId, session.wallet)
    console.log(`Deleted campaign ${appId.toString()}.`)
    printConfirmation(confirmation, options.network)
    if (status === 'failed' && header.raisedMicroAlgos > 0n) {
      console.log('Backers keep refunding from the vault until the refund window closes.')
    }
    console.log("The campaign's schema MBR and any Registry registration deposit are back in your account.")
    return 0
  } finally {
    await session.close()
  }
}
