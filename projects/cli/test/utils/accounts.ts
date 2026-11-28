import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants'
import type { WalletSession } from '@kasakame/sdk'
import type { Account } from 'algosdk'
import { secretKeyToMnemonic } from 'algosdk'

/** A funded account usable both as the test-process SDK signer and as the CLI's mnemonic. */
export interface CliSigner {
  account: Account
  address: string
  mnemonic: string
  wallet: WalletSession
}

/**
 * Generate a funded account and derive the 25-word phrase the CLI decodes.
 *
 * @param fixture The Algorand fixture.
 * @param algos Starting balance in ALGO.
 * @returns The account, address, phrase, and SDK wallet session.
 */
export async function newSigner(fixture: AlgorandFixture, algos = 20n): Promise<CliSigner> {
  const account = await fixture.context.generateAccount({
    initialFunds: microAlgos(algos * MICRO_ALGOS_PER_ALGO),
    suppressLog: true,
  })
  const address = account.addr.toString()
  return {
    account,
    address,
    mnemonic: secretKeyToMnemonic(account.sk),
    wallet: { address, signer: account.signer },
  }
}
