import algosdk from 'algosdk'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { expectCliError, expectCliOk, runCli } from './utils/index.js'

describe('CLI process boundary', () => {
  const account = algosdk.generateAccount()
  const address = account.addr.toString()
  const mnemonic = algosdk.secretKeyToMnemonic(account.sk)
  let tempDir: string

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'kasakame-cli-'))
  })

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('CLI-001 usage prints for no arguments and --help', { tags: ['smoke', 'always'] }, async () => {
    for (const argv of [[], ['--help']]) {
      const result = await runCli(argv)
      expectCliOk(result)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('Usage: kasakame <command> [options]')
      expect(result.stdout).toContain('settle-open <appId>')
      expect(result.stdout).toContain('--dry-run')
    }
  })

  test('CLI-002 whoami prints the mnemonic address', { tags: ['smoke', 'always'] }, async () => {
    const result = await runCli(['whoami'], { mnemonic })
    expectCliOk(result)
    expect(result.stdout).toContain('Signer: mnemonic')
    expect(result.stdout).toContain(`Address: ${address}`)
    expect(result.stdout).toContain('Network: localnet')
  })

  test('CLI-003 whoami reads --mnemonic-file', { tags: ['happy', 'always'] }, async () => {
    const file = path.join(tempDir, 'phrase.mnemonic')
    writeFileSync(file, mnemonic, { mode: 0o600 })

    const result = await runCli(['whoami', '--mnemonic-file', file], { mnemonic: '' })
    expectCliOk(result)
    expect(result.stdout).toContain(`Address: ${address}`)
  })

  test('CLI-004 argument errors exit before the chain', { tags: ['bad', 'always'] }, async () => {
    const unknown = await runCli(['nope'])
    expectCliError(unknown, 'Unknown command: nope')

    const mainnet = await runCli(['pledges', '--network', 'mainnet'])
    expectCliError(mainnet, 'MainNet is not supported yet')

    const appId = await runCli(['refund', '0', '--vault', '1'])
    expectCliError(appId, 'App id must be a positive integer')

    const dryRun = await runCli(['pledges', '--dry-run'], { vaultAppId: 1n })
    expectCliError(dryRun, '--dry-run is only valid with a write command')
  })

  test('CLI-005 localnet requires --vault and a mnemonic', { tags: ['bad', 'always'] }, async () => {
    const missingVault = await runCli(['pledges'], { mnemonic })
    expectCliError(missingVault, '--vault is required on localnet')

    const missingMnemonic = await runCli(['pledges'], { vaultAppId: 1n })
    expectCliError(missingMnemonic, 'Missing mnemonic: pass --mnemonic-file or set KASAKAME_MNEMONIC')
  })
})
