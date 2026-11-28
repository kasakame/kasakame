import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommandContext } from './context.js'
import type { CliOptions } from './options.js'

const openCliSessionMock = vi.hoisted(() => vi.fn())

vi.mock('../auth/open-session.js', () => ({ openCliSession: openCliSessionMock }))

const WALLET = { address: 'ADDRESS', signer: vi.fn() }

function options(): CliOptions {
  return { command: 'refund', appId: 1n, network: 'testnet', signer: 'mnemonic', dryRun: false }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createCommandContext', () => {
  it('opens the signer once and closes it after use', async () => {
    const close = vi.fn(() => Promise.resolve())
    openCliSessionMock.mockResolvedValue({ wallet: WALLET, close })
    const context = createCommandContext(options())
    expect(openCliSessionMock).not.toHaveBeenCalled()

    const first = await context.session()
    const second = await context.session()
    expect(first).toBe(second)
    expect(openCliSessionMock).toHaveBeenCalledOnce()

    await context.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not open the signer when the command never asks for it', async () => {
    const context = createCommandContext(options())

    await context.close()

    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('swallows an open failure during cleanup', async () => {
    openCliSessionMock.mockRejectedValue(new Error('missing mnemonic'))
    const context = createCommandContext(options())

    await expect(context.session()).rejects.toThrow('missing mnemonic')
    await expect(context.close()).resolves.toBeUndefined()
  })

  it('swallows a close failure during cleanup', async () => {
    openCliSessionMock.mockResolvedValue({
      wallet: WALLET,
      close: vi.fn(() => Promise.reject(new Error('relay down'))),
    })
    const context = createCommandContext(options())

    await context.session()
    await expect(context.close()).resolves.toBeUndefined()
  })
})
