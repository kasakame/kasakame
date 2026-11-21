import fs from 'node:fs'
import path from 'node:path'

/** Whether the script is targeting LocalNet (the default when ALGOD_SERVER is unset). */
export const isLocalNet = process.env.ALGOD_SERVER === undefined || process.env.ALGOD_SERVER.includes('localhost')

/** The network name used in the seed-state file. */
export const NETWORK = isLocalNet ? 'localnet' : 'testnet'

/** The seed-state file shared by `seed.ts` and `unseed.ts`. */
export const STATE_PATH = path.resolve(__dirname, `.seed-state.${NETWORK}.json`)

/** One seeded campaign in the seed-state file. */
export interface SeedEntry {
  appId: string
  creator: string
}

/** The seed-state file written by `seed.ts` and updated by `unseed.ts`. */
export interface SeedState {
  registryId?: string
  vaultId: string
  campaigns: SeedEntry[]
}

/**
 * Big-endian uint64 bytes for ABI app args.
 *
 * @param appId The application id.
 * @returns Eight bytes.
 */
export function appIdBytes(appId: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(appId)
  return buf
}

/**
 * The vault box key for a campaign: `'c' + appId`.
 *
 * @param appId The campaign application id.
 * @returns The box name.
 */
export function vaultBoxName(appId: bigint): Uint8Array {
  let remaining = appId
  const idBytes = new Uint8Array(8)
  for (let i = 7; i >= 0; i--) {
    idBytes[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return new Uint8Array([0x63, ...idBytes])
}

/**
 * Read the seed-state file.
 *
 * @returns The parsed state.
 */
export function readSeedState(): SeedState {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(`No ${path.basename(STATE_PATH)} found (run the matching seed script first).`)
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as SeedState
}

/**
 * Write the seed-state file.
 *
 * @param state The state to persist.
 */
export function writeSeedState(state: SeedState): void {
  // Pretty-printed: `prettier --check .` also covers this gitignored file.
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`)
}

/** Remove the seed-state file. */
export function clearSeedState(): void {
  fs.rmSync(STATE_PATH)
}
