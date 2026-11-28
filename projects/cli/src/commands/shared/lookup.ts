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
import { mnemonicAddress } from '../../auth/mnemonic/index.js'
import { whoami } from '../../auth/wallet/index.js'

export interface CampaignEntry {
  header: CampaignHeader
  status: CampaignStatus
}

/** A resolved read address and its wallet name, empty unless it came from the stored wallet session. */
export interface ResolvedAddress {
  address: string
  walletName: string
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
 * Resolve the address a command reads: an explicit `--address` for inspection, the mnemonic's address, or the stored wallet's address.
 *
 * @param options Parsed CLI options.
 * @param inspect When true, return a validated `--address` without touching a signer.
 * @returns The address and wallet name (empty unless it came from the stored session), or undefined when no wallet session is stored.
 */
export async function resolveAddress(options: CliOptions, inspect = true): Promise<ResolvedAddress | undefined> {
  if (inspect && options.address !== undefined) {
    if (!isValidAddress(options.address)) {
      throw new Error(`Invalid address: ${options.address}`)
    }
    return { address: options.address, walletName: '' }
  }
  if (options.signer === 'mnemonic') {
    return { address: await mnemonicAddress(options.mnemonicFile, undefined, options.address), walletName: '' }
  }
  const session = await whoami()
  return session === undefined ? undefined : { address: session.address, walletName: session.walletName }
}

/**
 * Resolve the address a read should inspect.
 *
 * @param options Parsed CLI options.
 * @returns The address to read.
 */
export async function readAddress(options: CliOptions): Promise<string> {
  const resolved = await resolveAddress(options)
  if (resolved === undefined) {
    throw new Error('No active wallet session. Run `kasakame login` first, or pass --address')
  }
  return resolved.address
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
