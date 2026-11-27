import type * as Sdk from '@kasakame/sdk'
import type { CliOptions } from '../app/options.js'

export const WALLET: Sdk.WalletSession = { address: 'BACKER', signer: () => Promise.resolve([]) }
export const VALID_ADDRESS = '4JBYQTVKROJEKG6IZWFAOGGAM2KH65E7JUSC3S5C4EPYOCWGZJOYIRKGRI'
export const HEADER = {
  id: 1n,
  creator: 'CREATOR',
  title: 'Title',
  metadataUri: 'ipfs://metadata',
  goalMicroAlgos: 10_000_000n,
  deadlineSeconds: 1_000n,
  raisedMicroAlgos: 2_000_000n,
  status: 'open' as const,
  deleted: false,
}

/**
 * Default CLI options for command tests.
 *
 * @param overrides Fields to override.
 * @returns The options.
 */
export function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    command: 'refund',
    appId: 1n,
    network: 'testnet',
    signer: 'mnemonic',
    dryRun: false,
    ...overrides,
  }
}

/**
 * A backer leaf fixture.
 *
 * @param position Leaf position.
 * @param amount Pledge amount in microAlgos.
 * @returns The leaf.
 */
export function leaf(position: number, amount: bigint) {
  return { position, amount, txidHex: 'aa' }
}

export const VAULT_OPEN = 1
export const VAULT_FAILED = 2
export const VAULT_CLAIMED = 3

/**
 * A vault box fixture.
 *
 * @param status Box status (1 open, 2 failed, 3 claimed).
 * @param overrides Fields to override.
 * @returns The vault box.
 */
export function vaultBox(status: number, overrides: Partial<Sdk.VaultBoxView> = {}): Sdk.VaultBoxView {
  return { paidIn: 2_000_000n, paidOut: 0n, status, settledAt: 1_000n, ...overrides }
}
