import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import type { CampaignHeader, CampaignStatus, WriteConfirmation } from '@kasakame/sdk'
import type { CliOptions } from '../../app/options.js'

/**
 * Status label for a campaign table row.
 *
 * @param header The campaign header.
 * @param status The derived campaign status.
 * @returns The display label.
 */
export function describeStatus(header: CampaignHeader, status: CampaignStatus): string {
  const base = header.status === 'claimed' ? 'successful (claimed)' : status
  return header.deleted ? `${base}, deleted` : base
}

/**
 * Action a backer can take on a campaign from the pledge table.
 *
 * @param header The campaign header.
 * @param status The derived campaign status.
 * @returns The action label.
 */
export function pledgeAction(header: CampaignHeader, status: CampaignStatus): string {
  if (status === 'successful') return '-'
  if (header.deleted && status === 'open') return 'window closed'
  return status === 'open' ? 'withdraw' : 'refund'
}

/**
 * Action a creator can take on a campaign from the campaign table.
 *
 * @param header The campaign header.
 * @param status The derived campaign status.
 * @returns The action label.
 */
export function campaignAction(header: CampaignHeader, status: CampaignStatus): string {
  if (header.deleted) return '-'
  if (header.status === 'claimed' || status === 'failed') return 'delete'
  if (status === 'successful') return 'claim'
  return header.raisedMicroAlgos === 0n ? 'delete' : '-'
}

/**
 * Print a two-space separated table, or a message when there are no rows.
 *
 * @param title Table title.
 * @param empty Message printed when the table has no rows.
 * @param headers Column headers.
 * @param rows Row cells.
 * @param note Optional line printed under the title.
 */
export function printTable(title: string, empty: string, headers: string[], rows: string[][], note?: string): void {
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

/**
 * Format a UNIX timestamp as an ISO-like UTC minute.
 *
 * @param seconds UNIX timestamp in seconds.
 * @returns The formatted deadline.
 */
export function formatDeadline(seconds: bigint): string {
  const iso = new Date(Number(seconds) * 1000).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

/**
 * Write a progress line to stderr.
 *
 * @param message The line to write.
 */
export function progress(message: string): void {
  console.error(message)
}

/**
 * Announce the pending submission in the signer's wording.
 *
 * @param options Parsed CLI options.
 * @param phrase What is being submitted.
 */
export function announceSubmit(options: CliOptions, phrase: string): void {
  progress(options.signer === 'wallet' ? `Waiting for wallet approval: ${phrase}…` : `Submitting: ${phrase}…`)
}

/**
 * Print the round and transaction of a confirmed write.
 *
 * @param confirmation The SDK confirmation.
 * @param network The active CLI network.
 */
export function printConfirmation(confirmation: WriteConfirmation, network: CliOptions['network']): void {
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

/**
 * Pluralize a pledge count.
 *
 * @param count Number of pledges.
 * @returns The count phrase.
 */
export function pledges(count: number): string {
  return `${String(count)} pledge${count === 1 ? '' : 's'}`
}

/**
 * Format microAlgos as an ALGO amount without trailing zeroes.
 *
 * @param microAlgos Amount in microAlgos.
 * @returns The ALGO amount.
 */
export function formatAlgo(microAlgos: bigint): string {
  const fraction = (microAlgos % MICRO_ALGOS_PER_ALGO).toString().padStart(6, '0').replace(/0+$/, '')
  const whole = (microAlgos / MICRO_ALGOS_PER_ALGO).toString()
  return fraction === '' ? whole : `${whole}.${fraction}`
}
