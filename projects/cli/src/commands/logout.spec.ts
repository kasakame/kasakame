import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runLogout } from './logout.js'
import { commandContext } from './test-fixtures.js'

const logoutMock = vi.hoisted(() => vi.fn())

vi.mock('../auth/wallet/index.js', () => ({ logout: logoutMock }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runLogout', () => {
  it('disconnects the session', async () => {
    logoutMock.mockResolvedValue(true)

    expect(await runLogout(commandContext())).toBe(0)
    expect(console.log).toHaveBeenCalledWith('Disconnected.')
  })

  it('reports a logout with no session', async () => {
    logoutMock.mockResolvedValue(false)

    expect(await runLogout(commandContext())).toBe(0)
    expect(console.log).toHaveBeenCalledWith('No active wallet session.')
  })

  it('does not open the write signer', async () => {
    logoutMock.mockResolvedValue(true)
    const context = commandContext()

    expect(await runLogout(context)).toBe(0)
    expect(context.session).not.toHaveBeenCalled()
  })
})
