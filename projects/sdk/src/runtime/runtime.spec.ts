import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchChainTimestamp } from './clock.js'
import { configureSdk, getSdkConfig } from './config.js'
import { waitForIndexerCatchUp, waitForIndexerCatchUpBestEffort, waitForIndexerRound } from './indexer.js'
import { sdkLogger, setSdkLogger } from './log.js'

const algodStatus = vi.fn()
const algodBlock = vi.fn()
const healthCheck = vi.fn()

function fakeAlgorand(): AlgorandClient {
  return {
    client: {
      algod: {
        status: () => ({ do: algodStatus }),
        block: (round: bigint) => ({ headerOnly: (headerOnly: boolean) => ({ do: () => algodBlock(round, headerOnly) }) }),
      },
      indexer: { makeHealthCheck: () => ({ do: healthCheck }) },
    },
  } as unknown as AlgorandClient
}

describe('configureSdk', () => {
  it('requires configuration before use', async () => {
    vi.resetModules()
    const fresh = await import('./config.js')
    expect(() => fresh.getSdkConfig()).toThrow('SDK not configured')
  })

  it('stores the session for later calls', () => {
    const algorand = fakeAlgorand()
    configureSdk({ algorand, registryAppId: 1001n, vaultAppId: 2002n })
    expect(getSdkConfig().algorand).toBe(algorand)
    expect(getSdkConfig().registryAppId).toEqual(1001n)
    expect(getSdkConfig().vaultAppId).toEqual(2002n)
  })

  it('installs the structured logger and resets it when omitted', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    configureSdk({ algorand: fakeAlgorand(), registryAppId: 1001n, vaultAppId: 2002n }, logger)
    expect(sdkLogger()).toBe(logger)

    configureSdk({ algorand: fakeAlgorand(), registryAppId: 1001n, vaultAppId: 2002n })
    expect(sdkLogger()).not.toBe(logger)
  })
})

describe('chain plumbing', () => {
  beforeEach(() => {
    configureSdk({ algorand: fakeAlgorand(), registryAppId: 1001n, vaultAppId: 2002n })
    algodStatus.mockReset()
    algodBlock.mockReset()
    healthCheck.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reads the latest block header timestamp', async () => {
    algodStatus.mockResolvedValue({ lastRound: 42n })
    algodBlock.mockResolvedValue({ block: { header: { timestamp: 123n } } })
    expect(await fetchChainTimestamp()).toEqual(123n)
    expect(algodBlock).toHaveBeenCalledWith(42n, true)
  })

  it('waits for the indexer to reach the chain tip', async () => {
    algodStatus.mockResolvedValue({ lastRound: 5n })
    healthCheck.mockResolvedValue({ round: 10n })
    await expect(waitForIndexerCatchUp(10_000, 250)).resolves.toBeUndefined()
  })

  it('swallows a post-write catch-up failure', async () => {
    const warn = vi.fn()
    setSdkLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() })
    algodStatus.mockRejectedValueOnce(new Error('algod unreachable'))

    await expect(waitForIndexerCatchUpBestEffort()).resolves.toBeUndefined()
    expect(algodStatus).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('indexer.wait-failed', { message: 'algod unreachable' })
  })

  it('stringifies a non-Error post-write catch-up failure', async () => {
    const warn = vi.fn()
    setSdkLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() })
    algodStatus.mockRejectedValueOnce('offline')

    await expect(waitForIndexerCatchUpBestEffort()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('indexer.wait-failed', { message: 'offline' })
  })
})

describe('waitForIndexerRound', () => {
  beforeEach(() => {
    configureSdk({ algorand: fakeAlgorand(), registryAppId: 1001n, vaultAppId: 2002n })
    healthCheck.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    setSdkLogger(undefined)
  })

  it('resolves immediately when the indexer is already past the round', async () => {
    healthCheck.mockResolvedValue({ round: 10n })

    await expect(waitForIndexerRound(5n)).resolves.toBeUndefined()
  })

  it('polls until the indexer catches up to the round', async () => {
    const rounds = [3n, 6n, 9n]
    healthCheck.mockImplementation(() => Promise.resolve({ round: rounds.shift() ?? 9n }))

    let resolved = false
    const promise = waitForIndexerRound(8n, 10_000, 250).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(250)
    await promise

    expect(resolved).toBe(true)
    expect(healthCheck).toHaveBeenCalledTimes(3)
  })

  it('gives up after the timeout', async () => {
    const warn = vi.fn()
    setSdkLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() })
    healthCheck.mockResolvedValue({ round: 1n })

    let resolved = false
    const promise = waitForIndexerRound(8n, 1_000, 250).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(1_000)
    await promise

    expect(resolved).toBe(true)
    expect(warn).toHaveBeenCalledWith('indexer.timeout', { round: '8', timeoutMs: 1_000 })
  })

  it('keeps polling when the health check is temporarily unreachable', async () => {
    healthCheck.mockRejectedValueOnce(new Error('unreachable')).mockResolvedValueOnce({ round: 10n })

    let resolved = false
    const promise = waitForIndexerRound(8n, 10_000, 250).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(250)
    await promise

    expect(resolved).toBe(true)
    expect(healthCheck).toHaveBeenCalledTimes(2)
  })
})
