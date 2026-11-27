import type { TransactionSigner } from 'algosdk'

export interface WalletConnectOptions {
  bridge?: string
  storagePath?: string
}

export interface WalletSessionInfo {
  address: string
  walletName: string
}

export interface LoginResult {
  session: WalletSessionInfo
  reused: boolean
}

export interface WalletConnection {
  info: WalletSessionInfo
  wallet: { address: string; signer: TransactionSigner }
  close: () => Promise<void>
}
