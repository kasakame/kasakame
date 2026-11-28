import {
  enumerateCampaigns,
  fetchCampaignHeader,
  fetchChainTimestamp,
  getCampaignStatus,
  type CampaignHeader,
  type CampaignStatus,
} from '@kasakame/sdk'
import { isValidAddress } from 'algosdk'
import type { CliOptions } from '../../app/options.js'
import { mnemonicSession } from '../../auth/mnemonic/index.js'
import { whoami } from '../../auth/wallet/index.js'

export interface CampaignEntry {
  header: CampaignHeader
  status: CampaignStatus
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNotFound(error: unknown): boolean {
  return /404|no application found/i.test(messageOf(error))
}

/**
 * Read the app id a write command requires.
 *
 * @param options Parsed CLI options.
 * @param command The command name for the error message.
 * @returns The campaign app id.
 */
export function requireAppId(options: CliOptions, command: string): bigint {
  const appId = options.appId
  if (appId === undefined) {
    throw new Error(`${command} requires exactly one app id`)
  }
  return appId
}

/**
 * Fetch a campaign header, mapping an unknown app to a not-found error.
 *
 * @param appId Campaign application id.
 * @param network The active network for the error message.
 * @returns The campaign header.
 */
export async function campaignHeader(appId: bigint, network: string): Promise<CampaignHeader> {
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

/**
 * Read a campaign's derived status from the indexer and the chain clock.
 *
 * @param appId Campaign application id.
 * @param network The active network for the error message.
 * @returns The derived campaign status.
 */
export async function campaignStatus(appId: bigint, network: string): Promise<CampaignStatus> {
  return getCampaignStatus(await campaignHeader(appId, network), await fetchChainTimestamp())
}

/**
 * Resolve the address a read should inspect.
 *
 * @param options Parsed CLI options.
 * @returns The address to read.
 */
export async function readAddress(options: CliOptions): Promise<string> {
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

/**
 * List every discovered campaign with its derived status, sorted by app id.
 *
 * @returns The campaign entries.
 */
export async function listCampaignEntries(): Promise<CampaignEntry[]> {
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
