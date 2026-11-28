import { claim, fetchChainTimestamp, getCampaignStatus } from '@kasakame/sdk'
import type { CommandContext } from '../app/context.js'
import { announceSubmit, printConfirmation } from './shared/format.js'
import { campaignHeader, requireAppId } from './shared/lookup.js'

/**
 * Claim a successful campaign for its creator; a wallet that did not create it is rejected before anything is submitted.
 *
 * @param context Parsed command context.
 * @returns Process exit code.
 */
export async function runClaim(context: CommandContext): Promise<number> {
  const { options } = context
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

  const { wallet } = await context.session()
  if (header.creator !== wallet.address) {
    throw new Error(`Campaign ${appId.toString()} was created by ${header.creator}; only the creator can claim`)
  }
  if (options.dryRun) {
    console.log(`Would claim campaign ${appId.toString()} as ${wallet.address}.`)
    console.log('Dry run: nothing submitted.')
    return 0
  }

  announceSubmit(options, `claim campaign ${appId.toString()}`)
  const confirmation = await claim(appId, wallet)
  console.log(`Claimed campaign ${appId.toString()}; the vault paid its live total to ${wallet.address}.`)
  printConfirmation(confirmation, options.network)
  return 0
}
