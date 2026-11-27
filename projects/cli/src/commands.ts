import {
  MICRO_ALGOS_PER_ALGO,
  VAULT_BOX_STATUS_CLAIMED_HEX,
  VAULT_BOX_STATUS_FAILED_HEX,
  VAULT_BOX_STATUS_OPEN_HEX,
} from '@kasakame/constants'
import {
  cancelPledge,
  claim,
  deleteCampaign,
  enumerateCampaigns,
  fetchCampaignHeader,
  fetchChainTimestamp,
  fetchMyLeaves,
  fetchVaultBox,
  fetchVaultConfig,
  finalize,
  getCampaignStatus,
  refund,
  refundWindowEndsAt,
  releaseClaimed,
  settleOpen,
  type BackerLeaf,
  type CampaignHeader,
  type CampaignStatus,
  type WalletSession,
  type WriteConfirmation,
} from '@kasakame/sdk'
import { isValidAddress } from 'algosdk'
import type { CliOptions } from './args.js'
import { cliErrorMessage } from './errors.js'
import { mnemonicSession } from './mnemonic.js'
import { openCliSession } from './session.js'
import { whoami } from './walletconnect.js'

const VAULT_BOX_STATUS_OPEN = Number.parseInt(VAULT_BOX_STATUS_OPEN_HEX, 16)
const VAULT_BOX_STATUS_FAILED = Number.parseInt(VAULT_BOX_STATUS_FAILED_HEX, 16)
const VAULT_BOX_STATUS_CLAIMED = Number.parseInt(VAULT_BOX_STATUS_CLAIMED_HEX, 16)

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

/**
 * Settle a failed campaign permissionlessly when its creator is gone, so backers refund through the vault; the campaign app must still exist.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runSettleOpen(options: CliOptions): Promise<number> {
  const appId = requireAppId(options, 'settle-open')
  const header = await campaignHeader(appId, options.network)
  if (header.deleted) {
    throw new Error(`Campaign ${appId.toString()} was already deleted; deleting a failed campaign settles its vault box`)
  }
  if (getCampaignStatus(header, await fetchChainTimestamp()) === 'successful') {
    throw new Error(`Campaign ${appId.toString()} reached its goal; there is nothing to settle`)
  }
  const box = await fetchVaultBox(appId)
  if (box === undefined) {
    throw new Error(`Campaign ${appId.toString()} has no vault box; there is nothing to settle`)
  }
  if (box.status === VAULT_BOX_STATUS_FAILED) {
    throw new Error(`Campaign ${appId.toString()} is already settled; backers can refund it`)
  }
  if (box.status !== VAULT_BOX_STATUS_OPEN) {
    throw new Error(`Campaign ${appId.toString()} was not failed; there is nothing to settle`)
  }

  return runVaultWrite(options, {
    announce: `settle open campaign ${appId.toString()}`,
    plan: `Would settle campaign ${appId.toString()} as failed.`,
    submit: (wallet) => settleOpen(appId, wallet),
    report: `Settled campaign ${appId.toString()} as failed; backers can now refund through the vault.`,
  })
}

/**
 * Release a claimed campaign's vault box permissionlessly, recovering its minimum balance to the vault; a missing box is a no-op.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runReleaseClaimed(options: CliOptions): Promise<number> {
  const appId = requireAppId(options, 'release-claimed')
  const box = await fetchVaultBox(appId)
  if (box === undefined) {
    console.log(`Campaign ${appId.toString()} has no vault box; there is nothing to release.`)
    return 0
  }
  if (box.status !== VAULT_BOX_STATUS_CLAIMED) {
    throw new Error(`Campaign ${appId.toString()} is not claimed; only a claimed campaign's vault box can be released`)
  }

  return runVaultWrite(options, {
    announce: `release the vault box for claimed campaign ${appId.toString()}`,
    plan: `Would release the vault box for claimed campaign ${appId.toString()}.`,
    submit: (wallet) => releaseClaimed(appId, wallet),
    report: `Released the vault box for campaign ${appId.toString()}; its minimum balance is back in the vault's account.`,
  })
}

/**
 * Finalize a settled-failed campaign permissionlessly: sweep the residual to the vault's sweep target and release the box once the refund window closes or the box is fully paid out.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runFinalize(options: CliOptions): Promise<number> {
  const appId = requireAppId(options, 'finalize')
  const box = await fetchVaultBox(appId)
  if (box === undefined) {
    throw new Error(`Campaign ${appId.toString()} has no vault box; it was already finalized or never funded`)
  }
  if (box.status !== VAULT_BOX_STATUS_FAILED) {
    throw new Error(`Campaign ${appId.toString()} is not settled as failed; there is nothing to finalize`)
  }

  const residual = box.paidIn - box.paidOut
  if (residual > 0n) {
    const window = await fetchVaultConfig()
    const refundWindowEnd = refundWindowEndsAt(box.settledAt, window.window)
    if ((await fetchChainTimestamp()) < refundWindowEnd) {
      throw new Error(
        `The refund window for campaign ${appId.toString()} is open until ${formatDeadline(refundWindowEnd)}; backers can still refund`,
      )
    }
  }

  return runVaultWrite(options, {
    announce: `finalize campaign ${appId.toString()}`,
    plan:
      residual > 0n
        ? `Would finalize campaign ${appId.toString()} and sweep ${formatAlgo(residual)} ALGO to the vault's sweep target.`
        : `Would finalize campaign ${appId.toString()} and release its vault box.`,
    submit: (wallet) => finalize(appId, wallet),
    report:
      residual > 0n
        ? `Swept ${formatAlgo(residual)} ALGO to the vault's sweep target and released the vault box for campaign ${appId.toString()}.`
        : `Released the vault box for campaign ${appId.toString()}; there was nothing left to sweep.`,
  })
}

interface VaultWrite {
  announce: string
  plan: string
  submit: (wallet: WalletSession) => Promise<WriteConfirmation>
  report: string
}

async function runVaultWrite(options: CliOptions, write: VaultWrite): Promise<number> {
  const session = await openCliSession(options)
  try {
    if (options.dryRun) {
      console.log(write.plan)
      console.log('Dry run: nothing submitted.')
      return 0
    }

    announceSubmit(options, write.announce)
    const confirmation = await write.submit(session.wallet)
    console.log(write.report)
    printConfirmation(confirmation, options.network)
    return 0
  } finally {
    await session.close()
  }
}

/**
 * List the address's live pledges and the action each campaign allows now.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runPledges(options: CliOptions): Promise<number> {
  const address = await readAddress(options)
  const readOnly = options.address !== undefined
  progress(`Searching ${options.network} for live pledges by ${address}…`)

  let result: { rows: string[][]; multiple: boolean }
  try {
    result = await pledgeRows(await listCampaignEntries(), address, readOnly)
  } catch (error) {
    throw new Error(`Could not read pledges from the indexer: ${cliErrorMessage(error, 'pledges')}`)
  }

  const headers = ['app id', 'title', 'status', 'deadline', 'pledge', 'amount']
  if (!readOnly) headers.push('action')

  printTable(
    `Live pledges by ${address} on ${options.network}`,
    `No live pledges by ${address} on ${options.network}.`,
    headers,
    result.rows,
    readOnly ? "Read-only view; withdraw and refund need the pledge owner's wallet." : undefined,
  )
  if (!readOnly && result.multiple) {
    console.log('Use --all to act on every pledge.')
  }
  return 0
}

async function pledgeRows(entries: CampaignEntry[], address: string, readOnly: boolean): Promise<{ rows: string[][]; multiple: boolean }> {
  const rows: string[][] = []
  let multiple = false
  for (const { header, status } of entries) {
    const leaves = await fetchMyLeaves(header.id, address)
    if (leaves.length === 0) continue
    if (!readOnly && leaves.length > 1) multiple = true

    for (const leaf of leaves) {
      const row = [
        header.id.toString(),
        header.title,
        describeStatus(header, status),
        formatDeadline(header.deadlineSeconds),
        String(leaf.position),
        `${formatAlgo(leaf.amount)} ALGO`,
      ]
      if (!readOnly) {
        const action = pledgeAction(header, status)
        const selected =
          leaves.length > 1 && (action === 'withdraw' || action === 'refund') ? `${action} --pledge ${String(leaf.position)}` : action
        row.push(selected)
      }
      rows.push(row)
    }
  }
  return { rows, multiple }
}

/**
 * List the campaigns the address created and the action each one allows now.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runCampaigns(options: CliOptions): Promise<number> {
  const address = await readAddress(options)
  const readOnly = options.address !== undefined
  progress(`Searching ${options.network} for campaigns created by ${address}…`)

  const headers = ['app id', 'title', 'status', 'raised / goal', 'deadline']
  if (!readOnly) headers.push('action')

  let rows: string[][]
  try {
    rows = (await listCampaignEntries())
      .filter(({ header }) => header.creator === address)
      .map(({ header, status }) => {
        const row = [
          header.id.toString(),
          header.title,
          describeStatus(header, status),
          `${formatAlgo(header.raisedMicroAlgos)} / ${formatAlgo(header.goalMicroAlgos)} ALGO`,
          formatDeadline(header.deadlineSeconds),
        ]
        if (!readOnly) row.push(campaignAction(header, status))
        return row
      })
  } catch (error) {
    throw new Error(`Could not read campaigns from the indexer: ${cliErrorMessage(error, 'campaigns')}`)
  }

  printTable(
    `Campaigns created by ${address} on ${options.network}`,
    `No campaigns created by ${address} on ${options.network}.`,
    headers,
    rows,
    readOnly ? "Read-only view; claim and delete need the creator's wallet." : undefined,
  )
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
    return (await mnemonicSession(options.mnemonicFile, undefined, options.address)).address
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

function pledgeAction(header: CampaignHeader, status: CampaignStatus): string {
  if (status === 'successful') return '-'
  if (header.deleted && status === 'open') return 'window closed'
  return status === 'open' ? 'withdraw' : 'refund'
}

function campaignAction(header: CampaignHeader, status: CampaignStatus): string {
  if (header.deleted) return '-'
  if (header.status === 'claimed' || status === 'failed') return 'delete'
  if (status === 'successful') return 'claim'
  return header.raisedMicroAlgos === 0n ? 'delete' : '-'
}

function describeStatus(header: CampaignHeader, status: CampaignStatus): string {
  const base = header.status === 'claimed' ? 'successful (claimed)' : status
  return header.deleted ? `${base}, deleted` : base
}

function printTable(title: string, empty: string, headers: string[], rows: string[][], note?: string): void {
  if (rows.length === 0) {
    console.log(empty)
    return
  }
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] as string).length)))
  const render = (cells: string[]): string =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] as number)))
      .join('  ')
      .trimEnd()

  console.log(`${title}:`)
  if (note !== undefined) console.log(note)
  console.log(render(headers))
  for (const row of rows) console.log(render(row))
}

function formatDeadline(seconds: bigint): string {
  const iso = new Date(Number(seconds) * 1000).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function progress(message: string): void {
  console.error(message)
}

function announceSubmit(options: CliOptions, phrase: string): void {
  progress(options.signer === 'wallet' ? `Waiting for wallet approval: ${phrase}…` : `Submitting: ${phrase}…`)
}

/**
 * Print the round and transaction of a confirmed write.
 *
 * @param confirmation The SDK confirmation.
 * @param network The active CLI network.
 */
function printConfirmation(confirmation: WriteConfirmation, network: CliOptions['network']): void {
  if (confirmation.confirmedRound !== undefined) {
    console.log(`Confirmed in round ${confirmation.confirmedRound.toString()}.`)
  }
  const txId = confirmation.txIds[0]
  if (txId === undefined) return
  console.log(`Transaction: ${txId}`)
  if (network !== 'custom') {
    console.log(`Explorer: https://lora.algokit.io/${network}/tx/${txId}`)
  }
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
  spend: (wallet: WalletSession, leaf: BackerLeaf) => Promise<WriteConfirmation>,
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

    if (selected.length > 1) {
      progress(
        options.signer === 'wallet'
          ? `${pledges(selected.length)} selected; your wallet asks for approval on each one.`
          : `${pledges(selected.length)} selected; each is a separate transaction.`,
      )
    }

    let failed = 0
    for (const leaf of selected) {
      try {
        announceSubmit(options, `${label.verb} pledge #${String(leaf.position)} (${formatAlgo(leaf.amount)} ALGO)`)
        const confirmation = await spend(session.wallet, leaf)
        console.log(`${label.done} pledge #${String(leaf.position)} (${formatAlgo(leaf.amount)} ALGO).`)
        printConfirmation(confirmation, options.network)
      } catch (error) {
        failed += 1
        const message = cliErrorMessage(error, options.command, appId)
        console.error(`Pledge #${String(leaf.position)} failed: ${message}`)
        if (options.logLevel === 'debug' && error instanceof Error && message !== error.message) {
          console.error(`[detail] ${error.message}`)
        }
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
  const fraction = (microAlgos % MICRO_ALGOS_PER_ALGO).toString().padStart(6, '0').replace(/0+$/, '')
  const whole = (microAlgos / MICRO_ALGOS_PER_ALGO).toString()
  return fraction === '' ? whole : `${whole}.${fraction}`
}
