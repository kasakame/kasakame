import {
  APP_ID_BYTES,
  VAULT_BOX_BYTES,
  VAULT_BOX_PAID_IN_OFFSET,
  VAULT_BOX_PAID_OUT_OFFSET,
  VAULT_BOX_PREFIX,
  VAULT_BOX_SETTLED_AT_OFFSET,
  VAULT_BOX_STATUS_FAILED_HEX,
  VAULT_BOX_STATUS_OFFSET,
} from '@kasakame/constants'
import { getApplicationAddress } from 'algosdk'
import { getSdkConfig } from '../chain.js'
import { ClaimsVaultClient } from '../generated/ClaimsVaultClient.js'

/** Vault box settlement state for refund routing and the window banner. */
export interface VaultBoxView {
  paidIn: bigint
  paidOut: bigint
  /** 1 = Open, 2 = Failed, 3 = Claimed. */
  status: number
  /** Settlement timestamp (seconds, 0 before settlement). */
  settledAt: bigint
}

export const VAULT_BOX_STATUS_FAILED = Number.parseInt(VAULT_BOX_STATUS_FAILED_HEX, 16)

/**
 * The vault's campaign box reference (key prefix 'c' + 8-byte big-endian app id) - inner vault calls require it
 * declared on the outer transaction.
 *
 * @param appId The campaign application id.
 * @returns Box references for the vault app.
 */
export function vaultBoxRef(appId: bigint): { appId: bigint; name: Uint8Array }[] {
  let remaining = appId
  const appIdBytes = new Uint8Array(APP_ID_BYTES)
  for (let i = APP_ID_BYTES - 1; i >= 0; i--) {
    appIdBytes[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return [{ appId: getSdkConfig().vaultAppId, name: new Uint8Array([VAULT_BOX_PREFIX.charCodeAt(0), ...appIdBytes]) }]
}

/**
 * The vault app's account address (where pledges go).
 *
 * @returns The vault's app account address.
 */
export function vaultAddress(): string {
  return getApplicationAddress(getSdkConfig().vaultAppId).toString()
}

/**
 * Read and unpack a campaign's vault box (fresh from algod - routing decisions must not use stale indexer state).
 *
 * @param appId Campaign application id.
 * @returns The unpacked box, or undefined when no box exists yet.
 */
export async function fetchVaultBox(appId: bigint): Promise<VaultBoxView | undefined> {
  const { algorand, vaultAppId } = getSdkConfig()
  const vaultClient = new ClaimsVaultClient({ algorand, appId: vaultAppId })
  let raw: Uint8Array
  try {
    raw = (await vaultClient.state.box.campaignBox.value(appId)) as Uint8Array
  } catch {
    return undefined
  }
  if (raw.length !== VAULT_BOX_BYTES) return undefined
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  return {
    paidIn: view.getBigUint64(VAULT_BOX_PAID_IN_OFFSET),
    paidOut: view.getBigUint64(VAULT_BOX_PAID_OUT_OFFSET),
    // The length check above guarantees the status byte exists; the fallback satisfies noUncheckedIndexedAccess.
    /* v8 ignore next */
    status: raw[VAULT_BOX_STATUS_OFFSET] ?? 0,
    settledAt: view.getBigUint64(VAULT_BOX_SETTLED_AT_OFFSET),
  }
}

/**
 * The vault's configured refund window (seconds), for the refund-window banner.
 *
 * @returns The window in seconds and the sweep target address.
 */
export async function fetchVaultConfig(): Promise<{ window: bigint; sweepTarget: string }> {
  const { algorand, vaultAppId } = getSdkConfig()
  const vaultClient = new ClaimsVaultClient({ algorand, appId: vaultAppId })
  const window = (await vaultClient.state.global.refundWindow()) as bigint
  const sweepTarget = (await vaultClient.state.global.sweepTarget()) as string
  return { window, sweepTarget }
}

/**
 * The refund window's end timestamp: settlement plus the vault's configured window. Refunds stay open until then;
 * afterwards `finalize` can sweep whatever is unclaimed (see docs/claim-tree-protocol.md).
 *
 * @param settledAt Settlement timestamp (seconds) from the vault box (`VaultBoxView.settledAt`).
 * @param window Refund window (seconds) from `fetchVaultConfig`.
 * @returns The window end as a UNIX timestamp (seconds).
 */
export function refundWindowEndsAt(settledAt: bigint, window: bigint): bigint {
  return settledAt + window
}
