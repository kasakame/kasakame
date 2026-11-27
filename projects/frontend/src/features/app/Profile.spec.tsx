import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSession } from '../../lib/backend'
import { clearProfileCache } from '../../lib/profiles'
import Profile from './Profile'

const useWalletMock = vi.fn()
const useNetworkMock = vi.fn()
const signDataMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
  useNetwork: () => useNetworkMock(),
}))

describe('Profile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWalletMock.mockReturnValue({
      activeAddress: 'ADDRESS',
      signData: (...args: unknown[]) => signDataMock(...args),
    })
    useNetworkMock.mockReturnValue({ activeNetworkConfig: { caipChainId: 'algorand:testnet' } })
    signDataMock.mockResolvedValue({ signature: new Uint8Array([1, 2, 3]), authenticatorData: new Uint8Array([4, 5, 6]) })
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
  })

  afterEach(() => {
    clearProfileCache()
    clearSession()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('asks to connect when disconnected', async () => {
    useWalletMock.mockReturnValue({ activeAddress: null })
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<Profile onBack={onBack} />)

    expect(screen.getByText(/Connect your wallet to view your profile/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('loads the saved profile into the form', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ display_name: 'Kyogre Fan', bio: 'Collector', avatar_cid: 'QmAvatar', email: 'kyogre@example.com' }),
        }),
    )
    render(<Profile onBack={() => {}} />)

    expect(await screen.findByDisplayValue('Kyogre Fan')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Collector')).toBeInTheDocument()
    expect(screen.getByDisplayValue('QmAvatar')).toBeInTheDocument()
    expect(screen.getByDisplayValue('kyogre@example.com')).toBeInTheDocument()
  })

  it('shows an empty form when no profile exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    )
    render(<Profile onBack={() => {}} />)

    await waitFor(() => {
      expect(screen.getByLabelText(/Display Name/)).toHaveValue('')
    })
    expect(screen.getByLabelText(/Bio/)).toHaveValue('')
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
        json: () => Promise.resolve({ display_name: 'Kyogre Fan', bio: 'Collector', email: 'kyogre@example.com' }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<Profile onBack={() => {}} />)

    expect(await screen.findByText(/Could not load your profile/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByDisplayValue('Kyogre Fan')).toBeInTheDocument()
    expect(screen.getByDisplayValue('kyogre@example.com')).toBeInTheDocument()
    expect(screen.queryByText(/Could not load your profile/)).not.toBeInTheDocument()
  })

  it('shows empty fields for missing profile data', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ bio: 'Collector' }) }),
    )
    render(<Profile onBack={() => {}} />)

    expect(await screen.findByDisplayValue('Collector')).toBeInTheDocument()
    expect(screen.getByLabelText(/Display Name/)).toHaveValue('')
  })

  it('saves the profile and shows success', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ display_name: 'New Name', avatar_cid: 'QmNewAvatar' }),
        }),
    )
    const user = userEvent.setup()
    render(<Profile onBack={() => {}} />)

    await user.clear(screen.getByLabelText(/Display Name/))
    await user.type(screen.getByLabelText(/Display Name/), 'New Name')
    await user.type(screen.getByLabelText(/Bio/), 'A collector')
    await user.type(screen.getByLabelText(/Avatar CID/), 'QmNewAvatar')
    await user.type(screen.getByLabelText(/Email/), 'new@example.com')
    await user.click(screen.getByRole('button', { name: 'Save Profile' }))

    expect(await screen.findByText('Profile saved.')).toBeInTheDocument()
    expect(screen.getByLabelText(/Display Name/)).toHaveValue('New Name')
    expect(screen.getByLabelText(/Bio/)).toHaveValue('')
  })

  it('saves only the fields the user changed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ display_name: 'Old Name', bio: 'Kept bio', email: 'kept@example.com' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ display_name: 'New Name', bio: 'Kept bio', email: 'kept@example.com' }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<Profile onBack={() => {}} />)

    await screen.findByDisplayValue('Old Name')
    await user.clear(screen.getByLabelText(/Display Name/))
    await user.type(screen.getByLabelText(/Display Name/), 'New Name')
    await user.click(screen.getByRole('button', { name: 'Save Profile' }))

    expect(await screen.findByText('Profile saved.')).toBeInTheDocument()
    const calls = fetchMock.mock.calls as unknown[][]
    const saveInit = calls[3]?.[1] as { body?: unknown } | undefined
    expect(saveInit?.body).toEqual(JSON.stringify({ display_name: 'New Name' }))
  })

  it('reports no changes when nothing was edited', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    )
    const user = userEvent.setup()
    render(<Profile onBack={() => {}} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save Profile' })).toBeEnabled()
    })
    await user.click(screen.getByRole('button', { name: 'Save Profile' }))

    expect(await screen.findByText('No changes.')).toBeInTheDocument()
  })

  it('shows an error when saving fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({ ok: false, status: 400, json: () => Promise.resolve({}) }),
    )
    const user = userEvent.setup()
    render(<Profile onBack={() => {}} />)

    await user.type(screen.getByLabelText(/Display Name/), 'New Name')
    await user.click(screen.getByRole('button', { name: 'Save Profile' }))

    expect(await screen.findByText('Saving failed. Try again.')).toBeInTheDocument()
  })

  it('goes back from the form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) }))
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<Profile onBack={onBack} />)

    await user.click(screen.getByRole('button', { name: '← Back' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('does not update the form when unmounted before a successful load finishes', async () => {
    let resolveProfile: ((value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveProfile = resolve
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = render(<Profile onBack={() => {}} />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
    unmount()

    if (resolveProfile === undefined) throw new Error('profile fetch was not called')
    resolveProfile({ ok: true, status: 200, json: () => Promise.resolve({ display_name: 'Late' }) })
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  it('does not show a load error after unmounting', async () => {
    let rejectProfile: ((reason: unknown) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectProfile = reject
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = render(<Profile onBack={() => {}} />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
    unmount()

    if (rejectProfile === undefined) throw new Error('profile fetch was not called')
    rejectProfile(new Error('offline'))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
})
