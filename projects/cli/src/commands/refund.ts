import { refund } from '@kasakame/sdk'
import type { CommandContext } from '../app/context.js'
import { spendLeaves } from './shared/leaves.js'
import { campaignStatus, requireAppId } from './shared/lookup.js'

/**
 * Refund every live pledge from a failed campaign, one wallet approval per pledge; every failed refund is reported and the rest still run.
 *
 * @param context Parsed command context.
 * @returns Process exit code.
 */
export async function runRefund(context: CommandContext): Promise<number> {
  const { options } = context
  const appId = requireAppId(options, 'refund')
  const status = await campaignStatus(appId, options.network)
  if (status === 'open') {
    throw new Error(`Campaign ${appId.toString()} is still open; use \`kasakame withdraw\` before the deadline`)
  }
  if (status === 'successful') {
    throw new Error(`Campaign ${appId.toString()} succeeded; there is nothing to refund`)
  }

  return spendLeaves(context, appId, { verb: 'refund', done: 'Refunded' }, (wallet, leaf) => refund(appId, wallet, leaf))
}
