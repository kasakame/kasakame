import { describe, expect, it } from 'vitest'
import { parseCliOptions } from './args.js'

describe('parseCliOptions', () => {
  it('defaults transaction commands to testnet with the deployed app ids', () => {
    expect(parseCliOptions(['refund', '123'])).toEqual({
      command: 'refund',
      appId: 123n,
      network: 'testnet',
      signer: 'wallet',
      vaultAppId: 774437570n,
      factoryAppId: 774437557n,
      dryRun: false,
    })
  })

  it('reads explicit network, signer, app ids, leaf, and dry-run', () => {
    expect(
      parseCliOptions([
        'withdraw',
        '42',
        '--network',
        'localnet',
        '--vault',
        '7',
        '--factory',
        '9',
        '--signer',
        'mnemonic',
        '--mnemonic-file',
        '/tmp/mnemonic',
        '--pledge',
        '2',
        '--dry-run',
      ]),
    ).toEqual({
      command: 'withdraw',
      appId: 42n,
      network: 'localnet',
      signer: 'mnemonic',
      vaultAppId: 7n,
      factoryAppId: 9n,
      mnemonicFile: '/tmp/mnemonic',
      pledge: 2,
      dryRun: true,
    })
  })

  it('reads --all for refund', () => {
    expect(parseCliOptions(['refund', '1', '--all'])).toEqual({
      command: 'refund',
      appId: 1n,
      network: 'testnet',
      signer: 'wallet',
      vaultAppId: 774437570n,
      factoryAppId: 774437557n,
      all: true,
      dryRun: false,
    })
  })

  it('rejects --pledge and --all together', () => {
    expect(() => parseCliOptions(['refund', '1', '--pledge', '0', '--all'])).toThrow('--pledge and --all cannot be combined')
  })

  it('rejects pledge selection outside refund and withdraw', () => {
    expect(() => parseCliOptions(['claim', '1', '--pledge', '0'])).toThrow('--pledge is only valid with refund or withdraw')
    expect(() => parseCliOptions(['delete', '1', '--all'])).toThrow('--all is only valid with refund or withdraw')
  })

  it('rejects an invalid pledge', () => {
    expect(() => parseCliOptions(['withdraw', '1', '--pledge', 'abc'])).toThrow('--pledge must be a non-negative integer')
    expect(() => parseCliOptions(['withdraw', '1', '--pledge=-1'])).toThrow('--pledge must be a non-negative integer')
    expect(() => parseCliOptions(['withdraw', '1', '--pledge', '99999999999999999999'])).toThrow('--pledge must be a non-negative integer')
  })

  it('defaults custom networks to the mnemonic signer', () => {
    expect(parseCliOptions(['claim', '5', '--network', 'custom', '--vault', '7'])).toEqual({
      command: 'claim',
      appId: 5n,
      network: 'custom',
      signer: 'mnemonic',
      vaultAppId: 7n,
      dryRun: false,
    })
  })

  it('allows an explicit mnemonic signer on testnet', () => {
    const options = parseCliOptions(['refund', '1', '--signer', 'mnemonic', '--mnemonic-file', 'mnemonic.txt'])

    expect(options.signer).toBe('mnemonic')
    expect(options.mnemonicFile).toBe('mnemonic.txt')
  })

  it('defaults session commands to testnet wallet', () => {
    expect(parseCliOptions(['login'])).toEqual({
      command: 'login',
      network: 'testnet',
      signer: 'wallet',
      dryRun: false,
    })
    expect(parseCliOptions(['whoami'])).toEqual({
      command: 'whoami',
      network: 'testnet',
      signer: 'wallet',
      dryRun: false,
    })
  })

  it('defaults whoami to mnemonic on localnet', () => {
    expect(parseCliOptions(['whoami', '--network', 'localnet'])).toEqual({
      command: 'whoami',
      network: 'localnet',
      signer: 'mnemonic',
      dryRun: false,
    })
  })

  it('defaults reads to testnet with the deployed app ids', () => {
    expect(parseCliOptions(['pledges'])).toEqual({
      command: 'pledges',
      network: 'testnet',
      signer: 'wallet',
      vaultAppId: 774437570n,
      factoryAppId: 774437557n,
      dryRun: false,
    })
  })

  it('carries an inspection address for reads', () => {
    expect(parseCliOptions(['campaigns', '--address', 'ADDRESS'])).toEqual({
      command: 'campaigns',
      address: 'ADDRESS',
      network: 'testnet',
      signer: 'wallet',
      vaultAppId: 774437570n,
      factoryAppId: 774437557n,
      dryRun: false,
    })
  })

  it('rejects --address with a wallet-signed transaction', () => {
    expect(() => parseCliOptions(['refund', '1', '--address', 'ADDRESS'])).toThrow(
      '--address is only valid with pledges or campaigns, or with --signer mnemonic',
    )
  })

  it('accepts --address to pick the account behind a 24-word mnemonic', () => {
    expect(parseCliOptions(['refund', '1', '--signer', 'mnemonic', '--address', 'ADDRESS'])).toMatchObject({
      command: 'refund',
      signer: 'mnemonic',
      address: 'ADDRESS',
    })
  })

  it('requires a vault for reads outside testnet', () => {
    expect(() => parseCliOptions(['pledges', '--network', 'localnet'])).toThrow('--vault is required on localnet')
  })

  it('accepts a zero factory id', () => {
    expect(parseCliOptions(['refund', '1', '--factory', '0']).factoryAppId).toBe(0n)
  })

  it('rejects an unknown command', () => {
    expect(() => parseCliOptions([])).toThrow('Unknown command:')
    expect(() => parseCliOptions(['nope'])).toThrow('Unknown command: nope')
  })

  it('rejects mainnet', () => {
    expect(() => parseCliOptions(['refund', '1', '--network', 'mainnet'])).toThrow('MainNet is not supported yet')
  })

  it('rejects an unknown network', () => {
    expect(() => parseCliOptions(['refund', '1', '--network', 'devnet'])).toThrow('Unknown network: devnet')
  })

  it('rejects an unknown signer', () => {
    expect(() => parseCliOptions(['refund', '1', '--signer', 'ledger'])).toThrow('Unknown signer: ledger')
  })

  it('rejects wallet signers on localnet', () => {
    expect(() => parseCliOptions(['refund', '1', '--network', 'localnet', '--vault', '7', '--signer', 'wallet'])).toThrow(
      'WalletConnect wallets do not support localnet',
    )
  })

  it('rejects login and logout outside testnet', () => {
    expect(() => parseCliOptions(['login', '--network', 'localnet'])).toThrow('login is only available on testnet')
    expect(() => parseCliOptions(['logout', '--network', 'custom'])).toThrow('logout is only available on testnet')
  })

  it('rejects mnemonic login and logout', () => {
    expect(() => parseCliOptions(['login', '--signer', 'mnemonic'])).toThrow('login only supports --signer wallet')
    expect(() => parseCliOptions(['logout', '--signer', 'mnemonic'])).toThrow('logout only supports --signer wallet')
  })

  it('rejects a mnemonic file with the wallet signer', () => {
    expect(() => parseCliOptions(['refund', '1', '--mnemonic-file', 'mnemonic.txt'])).toThrow('--mnemonic-file requires --signer mnemonic')
  })

  it('accepts delete with dry-run', () => {
    expect(parseCliOptions(['delete', '7', '--dry-run'])).toEqual({
      command: 'delete',
      appId: 7n,
      network: 'testnet',
      signer: 'wallet',
      vaultAppId: 774437570n,
      factoryAppId: 774437557n,
      dryRun: true,
    })
  })

  it('rejects dry-run outside transaction commands', () => {
    expect(() => parseCliOptions(['login', '--dry-run'])).toThrow('--dry-run is only valid with refund, withdraw, claim, or delete')
  })

  it('requires exactly one app id for transaction commands', () => {
    expect(() => parseCliOptions(['refund'])).toThrow('refund requires exactly one app id')
    expect(() => parseCliOptions(['refund', '1', '2'])).toThrow('refund requires exactly one app id')
  })

  it('rejects app ids on session commands', () => {
    expect(() => parseCliOptions(['whoami', '1'])).toThrow('whoami does not take an app id')
  })

  it('rejects invalid and zero app ids', () => {
    expect(() => parseCliOptions(['refund', 'abc'])).toThrow('App id must be a positive integer')
    expect(() => parseCliOptions(['refund', '0'])).toThrow('App id must be a positive integer')
  })

  it('requires a vault on localnet and custom networks', () => {
    expect(() => parseCliOptions(['refund', '1', '--network', 'localnet'])).toThrow('--vault is required on localnet')
    expect(() => parseCliOptions(['refund', '1', '--network', 'custom'])).toThrow('--vault is required on custom')
  })

  it('rejects invalid vault and factory ids', () => {
    expect(() => parseCliOptions(['refund', '1', '--vault', '0'])).toThrow('--vault must be a positive integer')
    expect(() => parseCliOptions(['refund', '1', '--factory', 'abc'])).toThrow('--factory must be a non-negative integer')
  })

  it('rejects unknown options', () => {
    expect(() => parseCliOptions(['refund', '1', '--bogus'])).toThrow()
  })
})
