import { VAULT_BOX_STATUS_CLAIMED_HEX, VAULT_BOX_STATUS_FAILED_HEX, VAULT_BOX_STATUS_OPEN_HEX } from '@kasakame/constants'
import type { WalletSession, WriteConfirmation } from '@kasakame/sdk'
import type { CliOptions } from '../args.js'
import { openCliSession } from '../session.js'
import { announceSubmit, printConfirmation } from './format.js'

export const VAULT_BOX_STATUS_OPEN = Number.parseInt(VAULT_BOX_STATUS_OPEN_HEX, 16)
export const VAULT_BOX_STATUS_FAILED = Number.parseInt(VAULT_BOX_STATUS_FAILED_HEX, 16)
export const VAULT_BOX_STATUS_CLAIMED = Number.parseInt(VAULT_BOX_STATUS_CLAIMED_HEX, 16)

export interface VaultWrite {
  announce: string
  plan: string
  submit: (wallet: WalletSession) => Promise<WriteConfirmation>
  report: string
}

/**
 * Run one permissionless vault write with the configured signer and print its plan or confirmation.
 *
 * @param options Parsed CLI options.
 * @param write The pending vault write.
 * @returns Process exit code.
 */
export async function runVaultWrite(options: CliOptions, write: VaultWrite): Promise<number> {
  const session = await openCliSession(options)
  try {
    if (options.dryRun) {
      console.log(write.plan)
      console.log('Dry run: nothing submitted.')
      return 0
    }

    announceSubmit(options, write.announce)
    const confirmation = await write.submit(session.wallet)
    console.log(write.report)
    printConfirmation(confirmation, options.network)
    return 0
  } finally {
    await session.close()
  }
}
