import {
  cancelPledge,
  claim,
  deleteCampaign,
  enumerateCampaigns,
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
import { isValidAddress } from 'algosdk'
import type { CliOptions } from './args.js'
import { mnemonicSession } from './mnemonic.js'
import { openCliSession } from './session.js'
import { whoami } from './walletconnect.js'

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
  const status = await campaignStatus(appId, options.network)
  if (status === 'open') {
    throw new Error(`Campaign ${appId.toString()} is still open; use \`kasakame withdraw\` before the deadline`)
  }
  if (status === 'successful') {
    throw new Error(`Campaign ${appId.toString()} succeeded; there is nothing to refund`)
  }

  return spendLeaves(options, appId, { verb: 'refund', done: 'Refunded' }, (wallet, leaf) => refund(appId, wallet, leaf))
}

/**
 * Withdraw every live pledge of an open campaign, one wallet approval per pledge.
 *
 * Campaigns that already failed or succeeded are rejected before the wallet is touched. With several live pledges,
 * `--pledge` picks one and `--all` withdraws every one; a failed withdrawal is reported and the remaining pledges are
 * still attempted.
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

    announceSubmit(options)
    await claim(appId, session.wallet)
    console.log(`Claimed campaign ${appId.toString()}; the vault paid its live total to ${session.wallet.address}.`)
    return 0
  } finally {
    await session.close()
  }
}

/**
 * Delete a campaign for its creator.
 *
 * Campaigns that still hold live pledges while open, and funded campaigns that are not claimed yet, are rejected
 * before the wallet is touched. Backers of a failed campaign keep refunding from the vault after the deletion.
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

    announceSubmit(options)
    await deleteCampaign(appId, session.wallet)
    console.log(`Deleted campaign ${appId.toString()}.`)
    if (status === 'failed' && header.raisedMicroAlgos > 0n) {
      console.log('Backers keep refunding from the vault until the refund window closes.')
    }
    console.log("The campaign's schema MBR and any Factory registration deposit are back in your account.")
    return 0
  } finally {
    await session.close()
  }
}

/**
 * List the address's live pledges and the action each campaign allows now.
 *
 * Read-only: no signing session and no relay connection are opened.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runPledges(options: CliOptions): Promise<number> {
  const address = await readAddress(options)
  progress(`Searching ${options.network} for live pledges by ${address}…`)

  let rows: string[]
  try {
    rows = await pledgeRows(await listCampaignEntries(), address)
  } catch (error) {
    throw new Error(`Could not read pledges from the indexer: ${messageOf(error)}`)
  }

  printRows(`Live pledges by ${address} on ${options.network}`, `No live pledges by ${address} on ${options.network}.`, rows)
  return 0
}

async function pledgeRows(entries: CampaignEntry[], address: string): Promise<string[]> {
  const rows: string[] = []
  for (const { header, status } of entries) {
    const leaves = await fetchMyLeaves(header.id, address)
    if (leaves.length === 0) continue
    rows.push(
      `#${header.id.toString()} "${header.title}" ${describeStatus(header, status)}, deadline ${formatDeadline(header.deadlineSeconds)}`,
    )
    for (const leaf of leaves) {
      rows.push(`  pledge #${String(leaf.position)}: ${formatAlgo(leaf.amount)} ALGO (txid ${leaf.txidHex})`)
    }
    rows.push(
      `  ${pledgeSuffix(
        header,
        status,
        leaves.map((leaf) => leaf.position),
      )}`,
    )
  }
  return rows
}

/**
 * List the campaigns the address created and the action each one allows now.
 *
 * Read-only: no signing session and no relay connection are opened.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runCampaigns(options: CliOptions): Promise<number> {
  const address = await readAddress(options)
  progress(`Searching ${options.network} for campaigns created by ${address}…`)

  let rows: string[]
  try {
    rows = (await listCampaignEntries())
      .filter(({ header }) => header.creator === address)
      .map(
        ({ header, status }) =>
          `#${header.id.toString()} "${header.title}" ${describeStatus(header, status)}, raised ${formatAlgo(header.raisedMicroAlgos)} of ${formatAlgo(header.goalMicroAlgos)} ALGO, deadline ${formatDeadline(header.deadlineSeconds)}, ${campaignSuffix(header, status)}`,
      )
  } catch (error) {
    throw new Error(`Could not read campaigns from the indexer: ${messageOf(error)}`)
  }

  printRows(`Campaigns created by ${address} on ${options.network}`, `No campaigns created by ${address} on ${options.network}.`, rows)
  return 0
}

async function readAddress(options: CliOptions): Promise<string> {
  if (options.address !== undefined) {
    if (!isValidAddress(options.address)) {
      throw new Error(`Invalid address: ${options.address}`)
    }
    return options.address
  }
  if (options.signer === 'mnemonic') {
    return mnemonicSession(options.mnemonicFile).address
  }
  const session = await whoami()
  if (session === undefined) {
    throw new Error('No active wallet session. Run `kasakame login` first, or pass --address')
  }
  return session.address
}

interface CampaignEntry {
  header: CampaignHeader
  status: CampaignStatus
}

async function listCampaignEntries(): Promise<CampaignEntry[]> {
  const nowSeconds = await fetchChainTimestamp()
  const entries: CampaignEntry[] = []
  for (const appId of await enumerateCampaigns()) {
    let header: CampaignHeader | undefined
    try {
      header = await fetchCampaignHeader(appId)
    } catch (error) {
      if (!isNotFound(error)) throw error
      continue
    }
    if (header !== undefined) {
      entries.push({ header, status: getCampaignStatus(header, nowSeconds) })
    }
  }
  return entries.sort((a, b) => Number(a.header.id - b.header.id))
}

function pledgeSuffix(header: CampaignHeader, status: CampaignStatus, positions: number[]): string {
  if (status === 'successful') return 'no action available'
  if (header.deleted && status === 'open') return 'no action available (refund window closed)'
  const verb = status === 'open' ? 'withdraw' : 'refund'
  if (positions.length === 1) return `you can: ${verb}`
  return `you can: ${verb} --pledge <${positions.map(String).join('|')}> or --all`
}

function campaignSuffix(header: CampaignHeader, status: CampaignStatus): string {
  if (header.deleted) return 'no action available'
  if (header.status === 'claimed' || status === 'failed') return 'you can: delete'
  if (status === 'successful') return 'you can: claim'
  return header.raisedMicroAlgos === 0n ? 'you can: delete' : 'no action available'
}

function describeStatus(header: CampaignHeader, status: CampaignStatus): string {
  const base = header.status === 'claimed' ? 'successful (claimed)' : status
  return header.deleted ? `${base}, deleted` : base
}

function printRows(title: string, empty: string, rows: string[]): void {
  if (rows.length === 0) {
    console.log(empty)
    return
  }
  console.log(`${title}:`)
  for (const row of rows) console.log(row)
}

function formatDeadline(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString()
}

function progress(message: string): void {
  console.error(message)
}

function announceSubmit(options: CliOptions): void {
  progress(options.signer === 'wallet' ? 'Waiting for wallet approval…' : 'Submitting…')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNotFound(error: unknown): boolean {
  return /404|no application found/i.test(messageOf(error))
}

function requireAppId(options: CliOptions, command: string): bigint {
  const appId = options.appId
  if (appId === undefined) {
    throw new Error(`${command} requires exactly one app id`)
  }
  return appId
}

async function campaignHeader(appId: bigint, network: string): Promise<CampaignHeader> {
  let header: CampaignHeader | undefined
  try {
    header = await fetchCampaignHeader(appId)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  if (header === undefined) {
    throw new Error(`Campaign ${appId.toString()} not found on ${network}`)
  }
  return header
}

async function campaignStatus(appId: bigint, network: string): Promise<CampaignStatus> {
  return getCampaignStatus(await campaignHeader(appId, network), await fetchChainTimestamp())
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
    const selected = selectLeaves(leaves, options, appId)

    if (options.dryRun) {
      for (const leaf of selected) {
        console.log(`Would ${label.verb} pledge #${String(leaf.position)} (${formatAlgo(leaf.amount)} ALGO).`)
      }
      console.log(`Dry run: ${pledges(selected.length)} would be ${label.done.toLowerCase()}.`)
      return 0
    }

    let failed = 0
    for (const leaf of selected) {
      try {
        announceSubmit(options)
        await spend(session.wallet, leaf)
        console.log(`${label.done} pledge #${String(leaf.position)} (${formatAlgo(leaf.amount)} ALGO).`)
      } catch (error) {
        failed += 1
        console.error(`Pledge #${String(leaf.position)} failed: ${messageOf(error)}`)
      }
    }

    if (failed > 0) {
      console.error(`${label.done} ${String(selected.length - failed)} of ${String(selected.length)} pledges; ${String(failed)} failed.`)
      return 1
    }
    console.log(`${label.done} ${pledges(selected.length)}.`)
    return 0
  } finally {
    await session.close()
  }
}

function selectLeaves(leaves: BackerLeaf[], options: CliOptions, appId: bigint): BackerLeaf[] {
  if (options.pledge !== undefined) {
    const leaf = leaves.find((candidate) => candidate.position === options.pledge)
    if (leaf === undefined) {
      throw new Error(`No live pledge #${String(options.pledge)} in campaign ${appId.toString()}`)
    }
    return [leaf]
  }
  if (options.all === true || leaves.length === 1) {
    return leaves
  }
  throw new Error(`You have ${String(leaves.length)} live pledges in campaign ${appId.toString()}; pass --pledge <position> or --all`)
}

function pledges(count: number): string {
  return `${String(count)} pledge${count === 1 ? '' : 's'}`
}

function formatAlgo(microAlgos: bigint): string {
  const fraction = (microAlgos % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  const whole = (microAlgos / 1_000_000n).toString()
  return fraction === '' ? whole : `${whole}.${fraction}`
}
