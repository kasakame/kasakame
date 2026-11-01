import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliOptions } from './args.js'
import { configureCliChain } from './chain.js'

const algorandMocks = vi.hoisted(() => {
  const testnet = { network: 'testnet' }
  const localnet = { network: 'localnet' }
  const custom = { network: 'custom' }
  return {
    testnet,
    localnet,
    custom,
    testNet: vi.fn(() => testnet),
    defaultLocalNet: vi.fn(() => localnet),
    fromEnvironment: vi.fn(() => custom),
  }
})
const configureSdkMock = vi.hoisted(() => vi.fn())

vi.mock('@algorandfoundation/algokit-utils', () => ({
  AlgorandClient: {
    testNet: algorandMocks.testNet,
    defaultLocalNet: algorandMocks.defaultLocalNet,
    fromEnvironment: algorandMocks.fromEnvironment,
  },
}))
vi.mock('@kasakame/sdk', () => ({ configureSdk: configureSdkMock }))

function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    command: 'refund',
    appId: 1n,
    network: 'testnet',
    signer: 'wallet',
    dryRun: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('configureCliChain', () => {
  it('configures TestNet with explicit app ids', () => {
    configureCliChain(options({ vaultAppId: 2n, factoryAppId: 3n }))

    expect(algorandMocks.testNet).toHaveBeenCalled()
    expect(configureSdkMock).toHaveBeenCalledWith({
      algorand: algorandMocks.testnet,
      factoryAppId: 3n,
      vaultAppId: 2n,
    })
  })

  it('configures LocalNet and defaults the factory to zero', () => {
    configureCliChain(options({ network: 'localnet', signer: 'mnemonic', vaultAppId: 7n }))

    expect(algorandMocks.defaultLocalNet).toHaveBeenCalled()
    expect(configureSdkMock).toHaveBeenCalledWith({
      algorand: algorandMocks.localnet,
      factoryAppId: 0n,
      vaultAppId: 7n,
    })
  })

  it('configures a custom network from the environment', () => {
    vi.stubEnv('ALGOD_SERVER', 'http://algod')
    vi.stubEnv('INDEXER_SERVER', 'http://indexer')

    configureCliChain(options({ network: 'custom', signer: 'mnemonic', vaultAppId: 7n, factoryAppId: 0n }))

    expect(algorandMocks.fromEnvironment).toHaveBeenCalled()
    expect(configureSdkMock).toHaveBeenCalledWith({
      algorand: algorandMocks.custom,
      factoryAppId: 0n,
      vaultAppId: 7n,
    })
  })

  it('rejects a custom network without algod and indexer URLs', () => {
    vi.stubEnv('ALGOD_SERVER', '')
    vi.stubEnv('INDEXER_SERVER', '')

    expect(() => {
      configureCliChain(options({ network: 'custom', signer: 'mnemonic', vaultAppId: 7n }))
    }).toThrow('Custom network requires ALGOD_SERVER and INDEXER_SERVER')
    expect(algorandMocks.fromEnvironment).not.toHaveBeenCalled()
    expect(configureSdkMock).not.toHaveBeenCalled()
  })

  it('rejects a custom network without an indexer URL', () => {
    vi.stubEnv('ALGOD_SERVER', 'http://algod')
    vi.stubEnv('INDEXER_SERVER', '')

    expect(() => {
      configureCliChain(options({ network: 'custom', signer: 'mnemonic', vaultAppId: 7n }))
    }).toThrow('Custom network requires ALGOD_SERVER and INDEXER_SERVER')
  })

  it('passes zero for missing app ids', () => {
    configureCliChain(options())

    expect(configureSdkMock).toHaveBeenCalledWith({
      algorand: algorandMocks.testnet,
      factoryAppId: 0n,
      vaultAppId: 0n,
    })
  })
})
