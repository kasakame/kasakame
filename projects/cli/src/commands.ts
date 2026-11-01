import {
  cancelPledge,
  claim,
  fetchCampaignHeader,
  fetchChainTimestamp,
  fetchMyLeaves,
  getCampaignStatus,
  refund,
  type BackerLeaf,
  type CampaignHeader,
  type CampaignStatus,
  type WalletSession,
} from '@kasakame/sdk'
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
  const appId = requireAppId(options, 'refund')
  const status = await campaignStatus(appId)
  if (status === 'open') {
    throw new Error(`Campaign ${appId.toString()} is still open; use \`kasakame cancel\` before the deadline`)
  }
  if (status === 'successful') {
    throw new Error(`Campaign ${appId.toString()} succeeded; there is nothing to refund`)
  }

  return spendLeaves(options, appId, { verb: 'refund', done: 'Refunded' }, (wallet, leaf) => refund(appId, wallet, leaf))
}

/**
 * Cancel every live pledge of an open campaign, one wallet approval per pledge.
 *
 * Campaigns that already failed or succeeded are rejected before the wallet is touched. A failed cancellation is
 * reported and the remaining pledges are still attempted; the command exits non-zero when any failed.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runCancel(options: CliOptions): Promise<number> {
  const appId = requireAppId(options, 'cancel')
  const status = await campaignStatus(appId)
  if (status === 'failed') {
    throw new Error(`Campaign ${appId.toString()} already failed; use \`kasakame refund\` instead`)
  }
  if (status === 'successful') {
    throw new Error(`Campaign ${appId.toString()} succeeded; its pledges can no longer be cancelled`)
  }

  return spendLeaves(options, appId, { verb: 'cancel', done: 'Cancelled' }, (wallet, leaf) => cancelPledge(appId, wallet, leaf))
}

/**
 * Claim a successful campaign for its creator.
 *
 * Open, failed, and already-claimed campaigns are rejected before the wallet is touched; a connected wallet that
 * did not create the campaign is rejected before anything is submitted.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runClaim(options: CliOptions): Promise<number> {
  const appId = requireAppId(options, 'claim')
  const header = await campaignHeader(appId)
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

    await claim(appId, session.wallet)
    console.log(`Claimed campaign ${appId.toString()}; the vault paid its live total to ${session.wallet.address}.`)
    return 0
  } finally {
    await session.close()
  }
}

function requireAppId(options: CliOptions, command: string): bigint {
  const appId = options.appId
  if (appId === undefined) {
    throw new Error(`${command} requires exactly one app id`)
  }
  return appId
}

async function campaignHeader(appId: bigint): Promise<CampaignHeader> {
  const header = await fetchCampaignHeader(appId)
  if (header === undefined) {
    throw new Error(`Campaign ${appId.toString()} not found`)
  }
  return header
}

async function campaignStatus(appId: bigint): Promise<CampaignStatus> {
  return getCampaignStatus(await campaignHeader(appId), await fetchChainTimestamp())
}

interface SpendLabel {
  verb: string
  done: string
}

/**
 * Spend every live leaf of the signer, one wallet approval per leaf, and report partial failures.
 *
 * @param options Parsed CLI options.
 * @param appId Campaign application id.
 * @param label Words for the progress and summary lines.
 * @param spend Submits one leaf spend through the wallet session.
 * @returns Process exit code.
 */
async function spendLeaves(
  options: CliOptions,
  appId: bigint,
  label: SpendLabel,
  spend: (wallet: WalletSession, leaf: BackerLeaf) => Promise<void>,
): Promise<number> {
  const session = await openCliSession(options)
  try {
    const leaves = await fetchMyLeaves(appId, session.wallet.address)
    if (leaves.length === 0) {
      console.log(`No live pledges to ${label.verb} from campaign ${appId.toString()}.`)
      return 0
    }

    if (options.dryRun) {
      for (const leaf of leaves) {
        console.log(`Would ${label.verb} pledge #${String(leaf.position)} (${formatAlgo(leaf.amount)} ALGO).`)
      }
      console.log(`Dry run: ${pledges(leaves.length)} would be ${label.done.toLowerCase()}.`)
      return 0
    }

    let failed = 0
    for (const leaf of leaves) {
      try {
        await spend(session.wallet, leaf)
        console.log(`${label.done} pledge #${String(leaf.position)} (${formatAlgo(leaf.amount)} ALGO).`)
      } catch (error) {
        failed += 1
        console.error(`Pledge #${String(leaf.position)} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (failed > 0) {
      console.error(`${label.done} ${String(leaves.length - failed)} of ${String(leaves.length)} pledges; ${String(failed)} failed.`)
      return 1
    }
    console.log(`${label.done} ${pledges(leaves.length)}.`)
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
