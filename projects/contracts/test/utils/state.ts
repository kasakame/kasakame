import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { appIdBytes } from '@kasakame/utils'

/**
 * @param vaultId The vault app id.
 * @param appId The campaign app id.
 * @returns The vault's campaign-box reference.
 */
export function vaultBoxRef(vaultId: bigint, appId: bigint): { appId: bigint; name: Uint8Array } {
  return { appId: vaultId, name: new Uint8Array(Buffer.concat([Buffer.from('c'), appIdBytes(appId)])) }
}

/**
 * @param registryId The Registry app id.
 * @param appId The campaign app id.
 * @returns The registration-box reference.
 */
export function registrationBoxRef(registryId: bigint, appId: bigint): { appId: bigint; name: Uint8Array } {
  return { appId: registryId, name: new Uint8Array(Buffer.concat([Buffer.from('r'), appIdBytes(appId)])) }
}

/** The vault's per-campaign box. */
export interface CampaignBox {
  paidIn: bigint
  paidOut: bigint
  root: string
  n: bigint
  status: number
  settledAt: bigint
}

/**
 * Read the vault's campaign box.
 *
 * @param vaultClient The vault client.
 * @param appId The campaign app id.
 * @returns The decoded box.
 */
export async function campaignBox(vaultClient: AppClient, appId: bigint): Promise<CampaignBox> {
  const raw = Buffer.from((await vaultClient.state.box.getMapValue('campaignBox', appId)) as Uint8Array)
  if (raw.length !== 65) throw new Error(`campaign box ${appId.toString()} has ${raw.length.toString()} bytes, expected 65`)
  return {
    paidIn: raw.subarray(0, 8).readBigUInt64BE(),
    paidOut: raw.subarray(8, 16).readBigUInt64BE(),
    root: raw.subarray(16, 48).toString('hex'),
    n: raw.subarray(48, 56).readBigUInt64BE(),
    status: raw[56] ?? 0,
    settledAt: raw.subarray(57, 65).readBigUInt64BE(),
  }
}

/**
 * Whether the vault's campaign box exists.
 *
 * @param vaultClient The vault client.
 * @param appId The campaign app id.
 * @returns True when the box is present.
 */
export async function campaignBoxExists(vaultClient: AppClient, appId: bigint): Promise<boolean> {
  try {
    await vaultClient.state.box.getMapValue('campaignBox', appId)
    return true
  } catch {
    return false
  }
}

/** The campaign globals the tests assert against the oracle. */
export interface CampaignState {
  n: bigint
  root: string
  raised: bigint
  status: bigint
}

/**
 * @param appClient The campaign client.
 * @returns The live campaign globals.
 */
export async function campaignState(appClient: AppClient): Promise<CampaignState> {
  const n = (await appClient.state.global.getValue('n')) as bigint
  const raised = (await appClient.state.global.getValue('raised')) as bigint
  const status = (await appClient.state.global.getValue('status')) as bigint
  const root = (await appClient.state.global.getValue('root')) as Uint8Array
  return { n, root: Buffer.from(root).toString('hex'), raised, status }
}
