import { cancelPledge } from '@kasakame/sdk'
import type { CliOptions } from '../app/options.js'
import { spendLeaves } from './shared/leaves.js'
import { campaignStatus, requireAppId } from './shared/lookup.js'

/**
 * Withdraw every live pledge of an open campaign, one wallet approval per pledge; `--pledge` picks one and `--all` takes every one.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runWithdraw(options: CliOptions): Promise<number> {
  const appId = requireAppId(options, 'withdraw')
  const status = await campaignStatus(appId, options.network)
  if (status === 'failed') {
    throw new Error(`Campaign ${appId.toString()} already failed; use \`kasakame refund\` instead`)
  }
  if (status === 'successful') {
    throw new Error(`Campaign ${appId.toString()} succeeded; its pledges can no longer be withdrawn`)
  }

  return spendLeaves(options, appId, { verb: 'withdraw', done: 'Withdrawn' }, (wallet, leaf) => cancelPledge(appId, wallet, leaf))
}
