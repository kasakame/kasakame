import type { SdkLogger } from '@kasakame/sdk'
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
const warningLogger = vi.hoisted(() => ({ level: 'warn' }))
const configureConfigMock = vi.hoisted(() => vi.fn())

vi.mock('@algorandfoundation/algokit-utils', () => ({
  AlgorandClient: {
    testNet: algorandMocks.testNet,
    defaultLocalNet: algorandMocks.defaultLocalNet,
    fromEnvironment: algorandMocks.fromEnvironment,
  },
  Config: { configure: configureConfigMock },
}))
vi.mock('@algorandfoundation/algokit-utils/types/logging', () => ({ warningConsoleLogger: warningLogger }))
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
  it('keeps the SDK logger at warnings', () => {
    configureCliChain(options())

    expect(configureConfigMock).toHaveBeenCalledWith({ logger: warningLogger })
  })

  it('passes a stderr logger in verbose mode', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    configureCliChain(options({ verbose: true }))

    const logger = configureSdkMock.mock.calls[0]?.[1] as SdkLogger
    logger.debug('refund.route', { appId: '9', route: 'vault' })
    logger.info('plain')
    logger.warn('indexer.timeout', { round: '8' })
    logger.error('refund.reroute', { type: 'routing' })

    expect(errorSpy).toHaveBeenCalledWith('[sdk:debug] refund.route {"appId":"9","route":"vault"}')
    expect(errorSpy).toHaveBeenCalledWith('[sdk:info] plain')
    expect(errorSpy).toHaveBeenCalledWith('[sdk:warn] indexer.timeout {"round":"8"}')
    expect(errorSpy).toHaveBeenCalledWith('[sdk:error] refund.reroute {"type":"routing"}')
  })

  it('configures TestNet with explicit app ids', () => {
    configureCliChain(options({ vaultAppId: 2n, registryAppId: 3n }))

    expect(algorandMocks.testNet).toHaveBeenCalled()
    expect(configureSdkMock).toHaveBeenCalledWith({
      algorand: algorandMocks.testnet,
      registryAppId: 3n,
      vaultAppId: 2n,
    })
  })

  it('configures LocalNet and defaults the registry to zero', () => {
    configureCliChain(options({ network: 'localnet', signer: 'mnemonic', vaultAppId: 7n }))

    expect(algorandMocks.defaultLocalNet).toHaveBeenCalled()
    expect(configureSdkMock).toHaveBeenCalledWith({
      algorand: algorandMocks.localnet,
      registryAppId: 0n,
      vaultAppId: 7n,
    })
  })

  it('configures a custom network from the environment', () => {
    vi.stubEnv('ALGOD_SERVER', 'http://algod')
    vi.stubEnv('INDEXER_SERVER', 'http://indexer')

    configureCliChain(options({ network: 'custom', signer: 'mnemonic', vaultAppId: 7n, registryAppId: 0n }))

    expect(algorandMocks.fromEnvironment).toHaveBeenCalled()
    expect(configureSdkMock).toHaveBeenCalledWith({
      algorand: algorandMocks.custom,
      registryAppId: 0n,
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
      registryAppId: 0n,
      vaultAppId: 0n,
    })
  })
})
