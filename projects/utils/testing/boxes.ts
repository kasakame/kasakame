import { appIdBytes } from './bytes.js'

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
 * Decode the vault's 65-byte campaign box.
 *
 * @param raw The box value.
 * @returns The decoded campaign box.
 */
export function decodeCampaignBox(raw: Uint8Array): CampaignBox {
  if (raw.length !== 65) throw new Error(`campaign box has ${raw.length.toString()} bytes, expected 65`)
  const bytes = Buffer.from(raw)
  return {
    paidIn: bytes.subarray(0, 8).readBigUInt64BE(),
    paidOut: bytes.subarray(8, 16).readBigUInt64BE(),
    root: bytes.subarray(16, 48).toString('hex'),
    n: bytes.subarray(48, 56).readBigUInt64BE(),
    status: raw[56] ?? 0,
    settledAt: bytes.subarray(57, 65).readBigUInt64BE(),
  }
}
