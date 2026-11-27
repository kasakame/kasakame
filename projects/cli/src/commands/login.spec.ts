import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runLogin } from './login.js'

const loginMock = vi.hoisted(() => vi.fn())

vi.mock('../auth/wallet/index.js', () => ({ login: loginMock }))

const SESSION = {
  address: 'ADDRESS',
  walletName: 'Pera Wallet',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runLogin', () => {
  it('logs in a new wallet session', async () => {
    loginMock.mockResolvedValue({ session: SESSION, reused: false })

    expect(await runLogin()).toBe(0)
    expect(console.log).toHaveBeenCalledWith('Connected Pera Wallet as ADDRESS.')
  })

  it('reports an already logged-in session', async () => {
    loginMock.mockResolvedValue({ session: SESSION, reused: true })

    expect(await runLogin()).toBe(0)
    expect(console.log).toHaveBeenCalledWith('Already logged in as ADDRESS (Pera Wallet).')
  })
})
