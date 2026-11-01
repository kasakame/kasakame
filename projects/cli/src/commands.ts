import { fetchCampaignHeader, fetchChainTimestamp, fetchMyLeaves, getCampaignStatus, refund } from '@kasakame/sdk'
import type { CliOptions } from './args.js'
import { openCliSession } from './session.js'

/**
 * Refund every live pledge from a failed campaign, one wallet approval per pledge.
 *
 * Open and successful campaigns are rejected before the wallet is touched. A failed refund is reported and the
 * remaining pledges are still attempted; the command exits non-zero when any refund failed.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runRefund(options: CliOptions): Promise<number> {
  const appId = options.appId
  if (appId === undefined) {
    throw new Error('refund requires exactly one app id')
  }

  const header = await fetchCampaignHeader(appId)
  if (header === undefined) {
    throw new Error(`Campaign ${appId.toString()} not found`)
  }

  const status = getCampaignStatus(header, await fetchChainTimestamp())
  if (status === 'open') {
    throw new Error(`Campaign ${appId.toString()} is still open; use \`kasakame cancel\` before the deadline`)
  }
  if (status === 'successful') {
    throw new Error(`Campaign ${appId.toString()} succeeded; there is nothing to refund`)
  }

  const session = await openCliSession(options)
  try {
    const leaves = await fetchMyLeaves(appId, session.wallet.address)
    if (leaves.length === 0) {
      console.log(`No live pledges to refund from campaign ${appId.toString()}.`)
      return 0
    }

    if (options.dryRun) {
      for (const leaf of leaves) {
        console.log(`Would refund pledge #${String(leaf.position)} (${formatAlgo(leaf.amount)} ALGO).`)
      }
      console.log(`Dry run: ${pledges(leaves.length)} would be refunded.`)
      return 0
    }

    let failed = 0
    for (const leaf of leaves) {
      try {
        await refund(appId, session.wallet, leaf)
        console.log(`Refunded pledge #${String(leaf.position)} (${formatAlgo(leaf.amount)} ALGO).`)
      } catch (error) {
        failed += 1
        console.error(`Pledge #${String(leaf.position)} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (failed > 0) {
      console.error(`Refunded ${String(leaves.length - failed)} of ${String(leaves.length)} pledges; ${String(failed)} failed.`)
      return 1
    }
    console.log(`Refunded ${pledges(leaves.length)}.`)
    return 0
  } finally {
    await session.close()
  }
}

function pledges(count: number): string {
  return `${String(count)} pledge${count === 1 ? '' : 's'}`
}

function formatAlgo(microAlgos: bigint): string {
  const fraction = (microAlgos % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  const whole = (microAlgos / 1_000_000n).toString()
  return fraction === '' ? whole : `${whole}.${fraction}`
}
