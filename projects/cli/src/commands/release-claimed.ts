import { fetchVaultBox, releaseClaimed } from '@kasakame/sdk'
import type { CommandContext } from '../app/context.js'
import { requireAppId } from './shared/lookup.js'
import { runVaultWrite, VAULT_BOX_STATUS_CLAIMED } from './shared/vault.js'

/**
 * Release a claimed campaign's vault box permissionlessly, recovering its minimum balance to the vault; a missing box is a no-op.
 *
 * @param context Parsed command context.
 * @returns Process exit code.
 */
export async function runReleaseClaimed(context: CommandContext): Promise<number> {
  const appId = requireAppId(context.options, 'release-claimed')
  const box = await fetchVaultBox(appId)
  if (box === undefined) {
    console.log(`Campaign ${appId.toString()} has no vault box; there is nothing to release.`)
    return 0
  }
  if (box.status !== VAULT_BOX_STATUS_CLAIMED) {
    throw new Error(`Campaign ${appId.toString()} is not claimed; only a claimed campaign's vault box can be released`)
  }

  return runVaultWrite(context, {
    announce: `release the vault box for claimed campaign ${appId.toString()}`,
    plan: `Would release the vault box for claimed campaign ${appId.toString()}.`,
    submit: (wallet) => releaseClaimed(appId, wallet),
    report: `Released the vault box for campaign ${appId.toString()}; its minimum balance is back in the vault's account.`,
  })
}
