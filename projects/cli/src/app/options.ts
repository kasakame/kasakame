import type { SdkLogLevel } from '@kasakame/sdk'

export type CommandName =
  | 'login'
  | 'whoami'
  | 'logout'
  | 'pledges'
  | 'campaigns'
  | 'refund'
  | 'withdraw'
  | 'claim'
  | 'delete'
  | 'settle-open'
  | 'finalize'
  | 'release-claimed'
export type NetworkName = 'testnet' | 'localnet' | 'custom'
export type SignerName = 'wallet' | 'mnemonic'

export interface CliOptions {
  command: CommandName
  appId?: bigint
  address?: string
  pledge?: number
  all?: boolean
  network: NetworkName
  signer: SignerName
  vaultAppId?: bigint
  registryAppId?: bigint
  mnemonicFile?: string
  dryRun: boolean
  logLevel?: SdkLogLevel
}
