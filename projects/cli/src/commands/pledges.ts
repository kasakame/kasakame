import { fetchMyLeaves } from '@kasakame/sdk'
import type { CliOptions } from '../args.js'
import { cliErrorMessage } from '../errors.js'
import { describeStatus, formatAlgo, formatDeadline, pledgeAction, printTable, progress } from './format.js'
import { listCampaignEntries, readAddress, type CampaignEntry } from './lookup.js'

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
