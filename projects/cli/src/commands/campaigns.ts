import type { CommandContext } from '../app/context.js'
import { cliErrorMessage } from '../app/error-messages.js'
import { campaignAction, describeStatus, formatAlgo, formatDeadline, printTable, progress } from './shared/format.js'
import { listCampaignEntries, readAddress } from './shared/lookup.js'

/**
 * List the campaigns the address created and the action each one allows now.
 *
 * @param context Parsed command context.
 * @returns Process exit code.
 */
export async function runCampaigns(context: CommandContext): Promise<number> {
  const { options } = context
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
