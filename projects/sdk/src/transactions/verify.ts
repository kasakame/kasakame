import { sha256 } from '@noble/hashes/sha2.js'
import { base64ToBytes, bytesToHex } from 'algosdk'
import { u64be } from '../claim-tree/tree.js'
import { APP_SPEC } from '../generated/CampaignClient.js'
import { RegistryClient } from '../generated/RegistryClient.js'
import { SPECS_VERSION } from '../generated/specs-version.js'
import { getSdkConfig } from '../runtime/config.js'
import { classifyChainError, SdkError, throwSdkError } from './errors.js'

/**
 * Hash the Campaign bytecode embedded in the generated spec: `sha256(itob(approval.length) ‖ approval ‖ clear)`.
 *
 * @returns The 32-byte program hash the Registry verifies at `register`.
 */
function campaignProgramHash(): Uint8Array {
  const byteCode = APP_SPEC.byteCode
  if (byteCode === undefined) {
    throwSdkError(new SdkError('validation', 'Campaign spec has no byteCode; run codegen first', { operation: 'verifyDeployment' }))
  }
  const approval = base64ToBytes(byteCode.approval)
  const clear = base64ToBytes(byteCode.clear)
  const preimage = new Uint8Array(8 + approval.length + clear.length)
  preimage.set(u64be(BigInt(approval.length)), 0)
  preimage.set(approval, 8)
  preimage.set(clear, 8 + approval.length)
  return sha256(preimage)
}

/**
 * Verify that the configured Registry expects this SDK's Campaign program hash; a mismatch would create a campaign that `register` rejects. No-op when no Registry is configured.
 *
 * @throws {Error} When the Registry expects another bundle, or its hash cannot be read.
 */
export async function verifyDeployment(): Promise<void> {
  const { algorand, registryAppId } = getSdkConfig()
  if (registryAppId === 0n) return
  let registryHash: Uint8Array | undefined
  try {
    const registry = new RegistryClient({ algorand, appId: registryAppId })
    registryHash = (await registry.state.global.campaignProgramHash()).asByteArray()
  } catch (error) {
    const classified = classifyChainError(error, { operation: 'verifyDeployment', appId: registryAppId })
    const message = `could not read the Registry campaign program hash: ${classified.message}`
    throwSdkError(
      new SdkError(classified.type, message, {
        operation: 'verifyDeployment',
        appId: registryAppId,
        ...(classified.code === undefined ? {} : { code: classified.code }),
        cause: error,
        details: error,
      }),
    )
  }
  const expectedHash = campaignProgramHash()
  if (registryHash === undefined || bytesToHex(registryHash) !== bytesToHex(expectedHash)) {
    const registryHex = registryHash === undefined ? 'missing' : bytesToHex(registryHash)
    throwSdkError(
      new SdkError(
        'registry-mismatch',
        `the Registry expects Campaign program hash ${registryHex}, but this SDK ships contracts ${SPECS_VERSION} (${bytesToHex(expectedHash)})`,
        { operation: 'verifyDeployment', appId: registryAppId },
      ),
    )
  }
}
