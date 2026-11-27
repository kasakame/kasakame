import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { decodeCampaignBox, type CampaignBox } from '@kasakame/utils/testing'

/**
 * Read the vault's campaign box.
 *
 * @param vaultClient The vault client.
 * @param appId The campaign app id.
 * @returns The decoded box.
 */
export async function campaignBox(vaultClient: AppClient, appId: bigint): Promise<CampaignBox> {
  const raw = (await vaultClient.state.box.getMapValue('campaignBox', appId)) as Uint8Array
  return decodeCampaignBox(raw)
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
