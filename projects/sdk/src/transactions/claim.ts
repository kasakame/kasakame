import { microAlgos } from '@algorandfoundation/algokit-utils'
import { CLAIM_EXTRA_INNERS } from '@kasakame/constants'
import { getSdkConfig } from '../runtime/config.js'
import { waitForIndexerRound } from '../runtime/indexer.js'
import type { WalletSession } from './clients.js'
import { campaignClientFor } from './clients.js'
import type { WriteConfirmation } from './confirmation.js'
import { writeConfirmation } from './confirmation.js'
import { logWriteConfirmed, submitWithClassification } from './errors.js'
import { minimumFee } from './fees.js'
import { vaultBoxRef } from './vault.js'

/**
 * Claim the campaign funds (creator only, after deadline, goal reached). The vault pays the derived live total.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @returns The confirmed transaction ids and round.
 */
export async function claim(appId: bigint, session: WalletSession): Promise<WriteConfirmation> {
  const { algorand, vaultAppId } = getSdkConfig()
  // Same signer registration as pledge (see cancelPledge): without it the send always throws "No signer found".
  algorand.account.setSigner(session.address, session.signer)
  const minFee = await minimumFee(algorand)
  const client = campaignClientFor(appId, session)
  const result = await submitWithClassification(
    'claim',
    () =>
      client.send.claim({
        args: [],
        appReferences: [vaultAppId],
        boxReferences: vaultBoxRef(appId),
        extraFee: microAlgos(CLAIM_EXTRA_INNERS * minFee),
      }),
    appId,
  )

  const confirmation = writeConfirmation(result, { appId })
  if (confirmation.confirmedRound !== undefined) {
    await waitForIndexerRound(confirmation.confirmedRound)
  }
  logWriteConfirmed('claim', appId, confirmation)
  return confirmation
}
