import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { TransactionSigner, TransactionWithSigner } from 'algosdk'
import { CampaignClient } from '../generated/CampaignClient.js'
import { ClaimsVaultClient } from '../generated/ClaimsVaultClient.js'
import { RegistryClient } from '../generated/RegistryClient.js'
import { getSdkConfig } from '../runtime/config.js'

export interface WalletSession {
  address: string
  signer: TransactionSigner
}

export type TransactionComposer = ReturnType<AlgorandClient['newGroup']>

/**
 * Detach built transactions from their composer's group id so an external composer can regroup and sign them.
 *
 * @param transactions The built transactions.
 * @returns The same transactions, ready for `addTransaction`.
 */
export function withoutGroupId(transactions: TransactionWithSigner[]): TransactionWithSigner[] {
  for (const transaction of transactions) delete transaction.txn.group
  return transactions
}

/**
 * A campaign client bound to the session's sender and signer.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @returns The configured campaign client.
 */
export function campaignClientFor(appId: bigint, session: WalletSession): CampaignClient {
  const { algorand } = getSdkConfig()
  return new CampaignClient({
    algorand,
    appId,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}

/**
 * A vault client bound to the session's sender and signer.
 *
 * @param session Wallet session holding the signer and address.
 * @returns The configured vault client.
 */
export function vaultClientFor(session: WalletSession): ClaimsVaultClient {
  const { algorand, vaultAppId } = getSdkConfig()
  return new ClaimsVaultClient({
    algorand,
    appId: vaultAppId,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}

/**
 * A Registry client bound to the session's sender and signer.
 *
 * @param session Wallet session holding the signer and address.
 * @returns The configured Registry client.
 */
export function registryClientFor(session: WalletSession): RegistryClient {
  const { algorand, registryAppId } = getSdkConfig()
  return new RegistryClient({
    algorand,
    appId: registryAppId,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}
