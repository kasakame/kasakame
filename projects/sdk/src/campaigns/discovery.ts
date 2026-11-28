import { REGISTRY_BOX_PREFIX, VAULT_BOX_PREFIX } from '@kasakame/constants'
import { RegistryClient } from '../generated/RegistryClient.js'
import { getSdkConfig } from '../runtime/config.js'
import { decodeBoxAppId } from './decode.js'

// Box name prefixes: a single byte plus an 8-byte big-endian campaign app id.
const REGISTRATION_BOX_PREFIX_BYTE = REGISTRY_BOX_PREFIX.charCodeAt(0)
const VAULT_BOX_PREFIX_BYTE = VAULT_BOX_PREFIX.charCodeAt(0)

/**
 * Fetch every app id registered with the Registry (paginated box search), decoded from the registration box names.
 *
 * @param registryId The Registry application id.
 * @returns The set of registered campaign app ids.
 */
export async function fetchRegisteredCampaignIds(registryId: bigint): Promise<Set<bigint>> {
  const indexer = getSdkConfig().algorand.client.indexer
  const registered = new Set<bigint>()
  let nextToken: string | undefined
  do {
    let query = indexer.searchForApplicationBoxes(registryId).limit(1000)
    if (nextToken !== undefined) query = query.nextToken(nextToken)
    const response = await query.do()
    for (const box of response.boxes) {
      // Box name: 'r' (1 byte) + the campaign app id (8 bytes, big-endian).
      const id = decodeBoxAppId(box.name, REGISTRATION_BOX_PREFIX_BYTE)
      if (id !== undefined) registered.add(id)
    }
    nextToken = response.nextToken
  } while (nextToken !== undefined)
  return registered
}

/**
 * Whether a campaign is registered - the check `ClaimsVault.credit` runs on a campaign's first pledge; gate pledge actions on it.
 *
 * @param appId Campaign application id.
 * @returns True when the Registry's registration box exists for the app; false when it does not, or when no Registry is
 *   configured (nothing can be registered then).
 */
export async function isRegistered(appId: bigint): Promise<boolean> {
  const { algorand, registryAppId } = getSdkConfig()
  if (registryAppId <= 0n) return false
  const registryClient = new RegistryClient({ algorand, appId: registryAppId })
  try {
    return (await registryClient.state.box.registered.value(appId)) !== undefined
  } catch (error) {
    // A deleted campaign has no registration box; algod reports that as 404 rather than an empty value.
    if (error instanceof Error && /box not found/i.test(error.message)) return false
    throw error
  }
}

/**
 * Fetch every campaign that has a vault box (live until the campaign settles and `notifyDelete` or `finalize` releases it), so deleted-but-unfinalized campaigns surface too.
 *
 * @param vaultId The ClaimsVault application id.
 * @returns Campaign app ids with a vault box.
 */
async function fetchVaultCampaignIds(vaultId: bigint): Promise<Set<bigint>> {
  const indexer = getSdkConfig().algorand.client.indexer
  const vaulted = new Set<bigint>()
  let nextToken: string | undefined
  do {
    let query = indexer.searchForApplicationBoxes(vaultId).limit(1000)
    if (nextToken !== undefined) query = query.nextToken(nextToken)
    const response = await query.do()
    for (const box of response.boxes) {
      // Box name: 'c' (1 byte) + the campaign app id (8 bytes, big-endian).
      const id = decodeBoxAppId(box.name, VAULT_BOX_PREFIX_BYTE)
      if (id !== undefined) vaulted.add(id)
    }
    nextToken = response.nextToken
  } while (nextToken !== undefined)
  return vaulted
}

/**
 * Enumerate every campaign app id worth browsing: registered with the Registry plus every campaign with a vault box (pledged, including deleted-but-unfinalized); the union dedupes.
 *
 * @returns The campaign app ids.
 */
export async function enumerateCampaigns(): Promise<Set<bigint>> {
  const { registryAppId, vaultAppId } = getSdkConfig()
  const registered = registryAppId > 0n ? await fetchRegisteredCampaignIds(registryAppId) : new Set<bigint>()
  const vaulted = await fetchVaultCampaignIds(vaultAppId)
  for (const id of vaulted) registered.add(id)
  return registered
}
