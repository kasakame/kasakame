import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSession } from '../../lib/backend'
import { clearSettingsCache } from '../../lib/profiles'
import Settings from './Settings'

const useWalletMock = vi.fn()
const useNetworkMock = vi.fn()
const signDataMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
  useNetwork: () => useNetworkMock(),
}))

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWalletMock.mockReturnValue({
      activeAddress: 'ADDRESS',
      activeWallet: { disconnect: () => Promise.resolve() },
      signData: (...args: unknown[]) => signDataMock(...args),
    })
    useNetworkMock.mockReturnValue({ activeNetworkConfig: { caipChainId: 'algorand:testnet' } })
    signDataMock.mockResolvedValue({ signature: new Uint8Array([1, 2, 3]), authenticatorData: new Uint8Array([4, 5, 6]) })
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
  })

  afterEach(() => {
    clearSettingsCache()
    clearSession()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('asks to connect when disconnected', async () => {
    useWalletMock.mockReturnValue({ activeAddress: null })
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<Settings onBack={onBack} />)

    expect(screen.getByText(/Connect your wallet to manage settings/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('loads the saved settings into the form', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ notify_funded: false, notify_failed: true, theme: 'dark' }),
        }),
    )
    render(<Settings onBack={() => {}} />)

    await waitFor(() => {
      expect(screen.getByLabelText(/Funded campaigns/)).not.toBeChecked()
    })
    expect(screen.getByLabelText(/Failed campaigns/)).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
  })

  it('saves toggled settings and shows success', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ notify_funded: false, notify_failed: true, theme: 'dark' }),
        }),
    )
    const user = userEvent.setup()
    render(<Settings onBack={() => {}} />)

    await user.click(screen.getByLabelText(/Funded campaigns/))
    await user.click(screen.getByLabelText(/Failed campaigns/))
    await user.click(screen.getByRole('radio', { name: 'Dark' }))
    await user.click(screen.getByRole('button', { name: 'Save Settings' }))

    expect(await screen.findByText('Settings saved.')).toBeInTheDocument()
  })

  it('saves only the settings the user changed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ notify_funded: true, notify_failed: true, theme: 'system' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ notify_funded: false, notify_failed: true, theme: 'system' }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<Settings onBack={() => {}} />)

    await waitFor(() => {
      expect(screen.getByLabelText(/Funded campaigns/)).toBeChecked()
    })
    await user.click(screen.getByLabelText(/Funded campaigns/))
    await user.click(screen.getByRole('button', { name: 'Save Settings' }))

    expect(await screen.findByText('Settings saved.')).toBeInTheDocument()
    const calls = fetchMock.mock.calls as unknown[][]
    const saveInit = calls[3]?.[1] as { body?: unknown } | undefined
    expect(saveInit?.body).toEqual(JSON.stringify({ notify_funded: false }))
  })

  it('reports no changes when nothing was edited', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ notify_funded: true, notify_failed: true, theme: 'system' }),
        }),
    )
    const user = userEvent.setup()
    render(<Settings onBack={() => {}} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save Settings' })).toBeEnabled()
    })
    await user.click(screen.getByRole('button', { name: 'Save Settings' }))

    expect(await screen.findByText('No changes.')).toBeInTheDocument()
  })

  it('shows an error when saving without a wallet object', async () => {
    useWalletMock.mockReturnValue({ activeAddress: 'ADDRESS', activeWallet: null })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) }))
    const user = userEvent.setup()
    render(<Settings onBack={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Save Settings' }))

    expect(await screen.findByText('Wallet not connected.')).toBeInTheDocument()
  })

  it('shows an error when saving fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({ ok: false, status: 400, json: () => Promise.resolve({}) }),
    )
    const user = userEvent.setup()
    render(<Settings onBack={() => {}} />)

    await user.click(screen.getByLabelText(/Funded campaigns/))
    await user.click(screen.getByRole('button', { name: 'Save Settings' }))

    expect(await screen.findByText('Saving failed. Try again.')).toBeInTheDocument()
  })

  it('goes back from the form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) }))
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<Settings onBack={onBack} />)

    await user.click(screen.getByRole('button', { name: '← Back' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('shows a load error and retries without wiping the form', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ notify_funded: false, notify_failed: true, theme: 'dark' }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<Settings onBack={() => {}} />)

    expect(await screen.findByText(/Could not load settings/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      expect(screen.getByLabelText(/Funded campaigns/)).not.toBeChecked()
    })
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
    expect(screen.queryByText(/Could not load settings/)).not.toBeInTheDocument()
  })

  it('keeps defaults without a backend', async () => {
    vi.stubEnv('VITE_BACKEND_URL', '')
    render(<Settings onBack={() => {}} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save Settings' })).toBeEnabled()
    })
    expect(screen.getByLabelText(/Funded campaigns/)).toBeChecked()
    expect(screen.queryByText(/Could not load settings/)).not.toBeInTheDocument()
  })

  it('shows a fallback message when saving throws without an error', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) }),
    )
    signDataMock.mockRejectedValueOnce('nope')
    const user = userEvent.setup()
    render(<Settings onBack={() => {}} />)

    await user.click(screen.getByLabelText(/Funded campaigns/))
    await user.click(screen.getByRole('button', { name: 'Save Settings' }))

    expect(await screen.findByText('Failed to save settings.')).toBeInTheDocument()
  })

  it('does not update the form when unmounted before a successful load finishes', async () => {
    let resolveSettings: ((value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSettings = resolve
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = render(<Settings onBack={() => {}} />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
    unmount()

    if (resolveSettings === undefined) throw new Error('settings fetch was not called')
    resolveSettings({ ok: true, status: 200, json: () => Promise.resolve({ notify_funded: false }) })
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  it('does not show a load error after unmounting', async () => {
    let rejectSettings: ((reason: unknown) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectSettings = reject
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = render(<Settings onBack={() => {}} />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
    unmount()

    if (rejectSettings === undefined) throw new Error('settings fetch was not called')
    rejectSettings(new Error('offline'))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
})
