import { cancelPledge } from '@kasakame/sdk'
import type { CommandContext } from '../app/context.js'
import { spendLeaves } from './shared/leaves.js'
import { campaignStatus, requireAppId } from './shared/lookup.js'

/**
 * Withdraw every live pledge of an open campaign, one wallet approval per pledge; `--pledge` picks one and `--all` takes every one.
 *
 * @param context Parsed command context.
 * @returns Process exit code.
 */
export async function runWithdraw(context: CommandContext): Promise<number> {
  const { options } = context
  const appId = requireAppId(options, 'withdraw')
  const status = await campaignStatus(appId, options.network)
  if (status === 'failed') {
    throw new Error(`Campaign ${appId.toString()} already failed; use \`kasakame refund\` instead`)
  }
  if (status === 'successful') {
    throw new Error(`Campaign ${appId.toString()} succeeded; its pledges can no longer be withdrawn`)
  }

  return spendLeaves(context, appId, { verb: 'withdraw', done: 'Withdrawn' }, (wallet, leaf) => cancelPledge(appId, wallet, leaf))
}
