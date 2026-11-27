import { claim, fetchChainTimestamp, getCampaignStatus } from '@kasakame/sdk'
import type { CliOptions } from '../args.js'
import { openCliSession } from '../session.js'
import { announceSubmit, printConfirmation } from './format.js'
import { campaignHeader, requireAppId } from './lookup.js'

/**
 * Claim a successful campaign for its creator; a wallet that did not create it is rejected before anything is submitted.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runClaim(options: CliOptions): Promise<number> {
  const appId = requireAppId(options, 'claim')
  const header = await campaignHeader(appId, options.network)
  const status = getCampaignStatus(header, await fetchChainTimestamp())
  if (status === 'open') {
    throw new Error(`Campaign ${appId.toString()} is still open; claim opens after its deadline`)
  }
  if (status === 'failed') {
    throw new Error(`Campaign ${appId.toString()} failed; there is nothing to claim`)
  }
  if (header.status === 'claimed') {
    throw new Error(`Campaign ${appId.toString()} was already claimed`)
  }

  const session = await openCliSession(options)
  try {
    if (header.creator !== session.wallet.address) {
      throw new Error(`Campaign ${appId.toString()} was created by ${header.creator}; only the creator can claim`)
    }
    if (options.dryRun) {
      console.log(`Would claim campaign ${appId.toString()} as ${session.wallet.address}.`)
      console.log('Dry run: nothing submitted.')
      return 0
    }

    announceSubmit(options, `claim campaign ${appId.toString()}`)
    const confirmation = await claim(appId, session.wallet)
    console.log(`Claimed campaign ${appId.toString()}; the vault paid its live total to ${session.wallet.address}.`)
    printConfirmation(confirmation, options.network)
    return 0
  } finally {
    await session.close()
  }
}
