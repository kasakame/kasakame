import { afterEach, describe, expect, it, vi } from 'vitest'
import { explorerTxUrl } from './explorer'

describe('explorerTxUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('builds a TestNet transaction URL', () => {
    vi.stubEnv('VITE_ALGOD_NETWORK', 'testnet')
    expect(explorerTxUrl('TX')).toEqual('https://lora.algokit.io/testnet/tx/TX')
  })

  it('defaults an empty network to LocalNet', () => {
    vi.stubEnv('VITE_ALGOD_NETWORK', '')
    expect(explorerTxUrl('TX')).toEqual('https://lora.algokit.io/localnet/tx/TX')
  })
})
