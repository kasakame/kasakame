import { fetchVaultBox, releaseClaimed } from '@kasakame/sdk'
import type { CliOptions } from '../args.js'
import { requireAppId } from './lookup.js'
import { runVaultWrite, VAULT_BOX_STATUS_CLAIMED } from './vault.js'

/**
 * Release a claimed campaign's vault box permissionlessly, recovering its minimum balance to the vault; a missing box is a no-op.
 *
 * @param options Parsed CLI options.
 * @returns Process exit code.
 */
export async function runReleaseClaimed(options: CliOptions): Promise<number> {
  const appId = requireAppId(options, 'release-claimed')
  const box = await fetchVaultBox(appId)
  if (box === undefined) {
    console.log(`Campaign ${appId.toString()} has no vault box; there is nothing to release.`)
    return 0
  }
  if (box.status !== VAULT_BOX_STATUS_CLAIMED) {
    throw new Error(`Campaign ${appId.toString()} is not claimed; only a claimed campaign's vault box can be released`)
  }

  return runVaultWrite(options, {
    announce: `release the vault box for claimed campaign ${appId.toString()}`,
    plan: `Would release the vault box for claimed campaign ${appId.toString()}.`,
    submit: (wallet) => releaseClaimed(appId, wallet),
    report: `Released the vault box for campaign ${appId.toString()}; its minimum balance is back in the vault's account.`,
  })
}
