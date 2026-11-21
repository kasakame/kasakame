import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import { ABIMethod, OnApplicationComplete } from 'algosdk'
import { clearSeedState, isLocalNet, readSeedState, vaultBoxName, writeSeedState, type SeedEntry } from './state'

/**
 * Remove campaigns created by `seed.ts`: creator-signed `unregister()` then `delete()` in one atomic group.
 * Unregister runs first because it reads the campaign's on-chain state, which a deleted app cannot provide; the group
 * drops the campaign from the browse list and recovers the registration deposit. An unregistered campaign's unregister
 * is a no-op, so the same group still deletes it. Reads `.seed-state.<network>.json` and clears entries that fully clean
 * up; anything left (e.g. a campaign that still has live pledges) is reported for a later retry after its deadline
 * passes.
 *
 * Same environment rules as the seed script: `npm run unseed:localnet` loads `.env.localnet`, `npm run unseed:testnet` loads `.env.testnet`.
 *
 * Usage: `npm run unseed:localnet` (the Registry and vault ids come from `.env.localnet`; `npm run unseed:testnet` reads `.env.testnet`)
 */

void (async () => {
  const state = readSeedState()
  const algorand = isLocalNet ? AlgorandClient.defaultLocalNet() : AlgorandClient.fromEnvironment()

  const registryId = BigInt(state.registryId ?? '0')
  const vaultId = BigInt(state.vaultId)
  const remaining: SeedEntry[] = []
  for (const entry of state.campaigns) {
    const appId = BigInt(entry.appId)
    const creator = await algorand.account.fromEnvironment(entry.creator)
    try {
      // One atomic group: unregister first (it reads the campaign's state), then delete.
      const composer = algorand.send.newGroup()
      composer.addAppCallMethodCall({
        appId: registryId,
        method: ABIMethod.fromSignature('unregister(uint64)void'),
        args: [appId],
        sender: creator.addr,
        appReferences: [appId],
        extraFee: microAlgos(1_000n),
      })
      composer.addAppCallMethodCall({
        appId,
        method: ABIMethod.fromSignature('delete()void'),
        args: [],
        sender: creator.addr,
        onComplete: OnApplicationComplete.DeleteApplicationOC,
        appReferences: [vaultId],
        boxReferences: [{ appId: vaultId, name: vaultBoxName(appId) }],
        extraFee: microAlgos(2_000n),
      })
      await composer.send()
      console.log(`unregistered and deleted campaign ${entry.appId}`)
    } catch (error) {
      console.log(`skipped ${entry.appId} (still live?): ${(error as Error).message}`)
      remaining.push(entry)
    }
  }

  if (remaining.length === 0) {
    clearSeedState()
    console.log('unseeded: state cleared')
  } else {
    writeSeedState({ ...state, campaigns: remaining })
  }
})()
