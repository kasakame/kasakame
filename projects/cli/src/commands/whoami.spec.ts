import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandContext } from './test-fixtures.js'
import { runWhoami } from './whoami.js'

const whoamiMock = vi.hoisted(() => vi.fn())
const mnemonicAddressMock = vi.hoisted(() => vi.fn())

vi.mock('../auth/wallet/index.js', () => ({ whoami: whoamiMock }))
vi.mock('../auth/mnemonic/index.js', () => ({ mnemonicAddress: mnemonicAddressMock }))

const SESSION = {
  address: 'ADDRESS',
  walletName: 'Pera Wallet',
}
const MNEMONIC_ADDRESS = 'MNEMONIC_ADDRESS'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runWhoami', () => {
  it('shows the current wallet session', async () => {
    whoamiMock.mockResolvedValue(SESSION)

    expect(await runWhoami(commandContext({ command: 'whoami', signer: 'wallet' }))).toBe(0)
    expect(console.log).toHaveBeenCalledWith('Wallet: Pera Wallet')
    expect(console.log).toHaveBeenCalledWith('Address: ADDRESS')
  })

  it('shows the mnemonic address', async () => {
    mnemonicAddressMock.mockResolvedValue(MNEMONIC_ADDRESS)

    expect(await runWhoami(commandContext({ command: 'whoami', mnemonicFile: '/tmp/mnemonic' }))).toBe(0)
    expect(mnemonicAddressMock).toHaveBeenCalledWith('/tmp/mnemonic', undefined, undefined)
    expect(console.log).toHaveBeenCalledWith('Signer: mnemonic')
    expect(console.log).toHaveBeenCalledWith('Address: MNEMONIC_ADDRESS')
    expect(console.log).toHaveBeenCalledWith('Network: testnet')
  })

  it('passes --address to a mnemonic whoami', async () => {
    mnemonicAddressMock.mockResolvedValue('ADDRESS')

    expect(await runWhoami(commandContext({ command: 'whoami', address: 'ADDRESS' }))).toBe(0)
    expect(mnemonicAddressMock).toHaveBeenCalledWith(undefined, undefined, 'ADDRESS')
  })

  it('fails when there is no session', async () => {
    whoamiMock.mockResolvedValue(undefined)

    expect(await runWhoami(commandContext({ command: 'whoami', signer: 'wallet' }))).toBe(1)
    expect(console.error).toHaveBeenCalledWith('No active wallet session. Run `kasakame login` first.')
  })

  it('does not open the write signer', async () => {
    mnemonicAddressMock.mockResolvedValue(MNEMONIC_ADDRESS)
    const context = commandContext({ command: 'whoami' })

    expect(await runWhoami(context)).toBe(0)
    expect(context.session).not.toHaveBeenCalled()
  })
})
