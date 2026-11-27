import type { ISessionStorage, IWalletConnectSession } from '@perawallet/walletconnect'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Store one WalletConnect session in a JSON file. */
export class FileSessionStorage implements ISessionStorage {
  /**
   * @param file Session file path.
   */
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  }

  getSession(): IWalletConnectSession | null {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as IWalletConnectSession
    } catch {
      return null
    }
  }

  setSession(session: IWalletConnectSession): IWalletConnectSession {
    writeFileSync(this.file, `${JSON.stringify(session)}\n`, { mode: 0o600 })
    return session
  }

  removeSession(): void {
    rmSync(this.file, { force: true })
  }
}

/**
 * Where the WalletConnect v1 session for TestNet is stored.
 *
 * @returns Absolute session file path.
 */
export function defaultSessionStoragePath(): string {
  return join(homedir(), '.kasakame', 'walletconnect', 'testnet.json')
}
