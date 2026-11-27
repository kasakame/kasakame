import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import { ABIMethod, OnApplicationComplete } from 'algosdk'
import { clearSeedState, isLocalNet, readSeedState, vaultBoxName, writeSeedState, type SeedEntry } from './state'

/**
 * Remove campaigns created by `seed.ts` with a creator-signed atomic `[unregister, delete]` group and clear them from the seed state.
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
