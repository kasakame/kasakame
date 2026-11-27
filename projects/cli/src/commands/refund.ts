import { refund } from '@kasakame/sdk'
import type { CliOptions } from '../args.js'
import { spendLeaves } from './leaves.js'
import { campaignStatus, requireAppId } from './lookup.js'

/**
 * Refund every live pledge from a failed campaign, one wallet approval per pledge; every failed refund is reported and the rest still run.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runRefund(options: CliOptions): Promise<number> {
  const appId = requireAppId(options, 'refund')
  const status = await campaignStatus(appId, options.network)
  if (status === 'open') {
    throw new Error(`Campaign ${appId.toString()} is still open; use \`kasakame withdraw\` before the deadline`)
  }
  if (status === 'successful') {
    throw new Error(`Campaign ${appId.toString()} succeeded; there is nothing to refund`)
  }

  return spendLeaves(options, appId, { verb: 'refund', done: 'Refunded' }, (wallet, leaf) => refund(appId, wallet, leaf))
}
