import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from './cli.js'

const loginMock = vi.hoisted(() => vi.fn())
const whoamiMock = vi.hoisted(() => vi.fn())
const logoutMock = vi.hoisted(() => vi.fn())

vi.mock('./walletconnect.js', () => ({
  login: loginMock,
  whoami: whoamiMock,
  logout: logoutMock,
}))

const SESSION = {
  address: 'ADDRESS',
  chainId: 'algorand:testnet',
  expiry: 1_700_000_000,
  walletName: 'Pera Wallet',
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('run', () => {
  it('prints usage with no arguments', async () => {
    expect(await run([])).toBe(0)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage: kasakame'))
  })

  it('prints usage with --help', async () => {
    expect(await run(['--help'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage: kasakame'))
  })

  it('prints usage with -h', async () => {
    expect(await run(['-h'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage: kasakame'))
  })

  it('logs in a new wallet session', async () => {
    loginMock.mockResolvedValue({ session: SESSION, reused: false })

    expect(await run(['login'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith('Connected Pera Wallet as ADDRESS.')
    expect(console.log).toHaveBeenCalledWith('Session expires: 2023-11-14T22:13:20.000Z')
  })

  it('reports an already logged-in session', async () => {
    loginMock.mockResolvedValue({ session: SESSION, reused: true })

    expect(await run(['login'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith('Already logged in as ADDRESS (Pera Wallet).')
  })

  it('shows the current session', async () => {
    whoamiMock.mockResolvedValue(SESSION)

    expect(await run(['whoami'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith('Wallet: Pera Wallet')
    expect(console.log).toHaveBeenCalledWith('Address: ADDRESS')
    expect(console.log).toHaveBeenCalledWith('Chain: algorand:testnet')
  })

  it('fails when there is no session', async () => {
    whoamiMock.mockResolvedValue(undefined)

    expect(await run(['whoami'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('No active wallet session. Run `kasakame login` first.')
  })

  it('disconnects the session', async () => {
    logoutMock.mockResolvedValue(true)

    expect(await run(['logout'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith('Disconnected.')
  })

  it('reports a logout with no session', async () => {
    logoutMock.mockResolvedValue(false)

    expect(await run(['logout'])).toBe(0)
    expect(console.log).toHaveBeenCalledWith('No active wallet session.')
  })

  it('rejects a command that is not implemented yet', async () => {
    expect(await run(['refund'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Not implemented yet: refund')
  })

  it('prints an Error message', async () => {
    loginMock.mockRejectedValue(new Error('relay down'))

    expect(await run(['login'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Error: relay down')
  })

  it('prints a non-Error rejection', async () => {
    loginMock.mockRejectedValue('relay down')

    expect(await run(['login'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Error: relay down')
  })
})
