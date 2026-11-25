import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScopeType } from '@txnlab/use-wallet'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSession } from '../../lib/backend'
import { toDateTimeLocal } from '../../lib/format'
import CreateCampaignForm from './CreateCampaignForm'

const CHAIN_NOW = 1_000_000_020n
const VALID_DEADLINE = CHAIN_NOW + 30n * 86_400n

const createCampaignMock = vi.fn()
const registerCampaignMock = vi.fn()
const fetchChainTimestampMock = vi.fn()
const logErrorMock = vi.fn()
const signDataMock = vi.fn()

vi.mock('../../lib/log', () => ({
  logError: (...args: unknown[]) => logErrorMock(...args),
}))

vi.mock('../../lib/transaction', async () => {
  const actual: { disconnectQuietly: (wallet: unknown) => Promise<void> } = await vi.importActual('../../lib/transaction')
  return {
    createCampaign: (...args: unknown[]) => createCampaignMock(...args),
    registerCampaign: (...args: unknown[]) => registerCampaignMock(...args),
    disconnectQuietly: actual.disconnectQuietly,
  }
})

vi.mock('../../lib/algorand', () => ({
  fetchChainTimestamp: (...args: unknown[]) => fetchChainTimestampMock(...args),
}))

const useWalletMock = vi.fn()
const useNetworkMock = vi.fn()
const disconnectMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
  useNetwork: () => useNetworkMock(),
}))

describe('CreateCampaignForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    disconnectMock.mockResolvedValue(undefined)
    signDataMock.mockResolvedValue({ signature: new Uint8Array([7, 8]), authenticatorData: new Uint8Array([9]) })
    useWalletMock.mockReturnValue({
      activeAddress: 'ADDRESS',
      activeWallet: { disconnect: disconnectMock, canSignData: true },
      signData: (...args: unknown[]) => signDataMock(...args),
      transactionSigner: {},
    })
    useNetworkMock.mockReturnValue({ activeNetworkConfig: { caipChainId: 'algorand:testnet' } })
    fetchChainTimestampMock.mockResolvedValue(CHAIN_NOW)
  })

  afterEach(() => {
    clearSession()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  async function setDeadline(seconds: bigint) {
    const input = screen.getByLabelText(/End date and time/)
    await waitFor(() => {
      expect(input).not.toHaveValue('')
    })
    fireEvent.change(input, { target: { value: toDateTimeLocal(seconds) } })
  }

  it('creates a campaign and calls onCreated with the new app id', { timeout: 20_000 }, async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ nonce: 'cover-nonce' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ token: 'session' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ cid: 'QmCover' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ cid: 'QmMeta' }) })
    vi.stubGlobal('fetch', fetchMock)
    createCampaignMock.mockResolvedValue({ appId: 99n, appAddress: 'ESCROW', registered: true })
    const onCreated = vi.fn()
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={onCreated} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.upload(screen.getByLabelText(/Choose cover/), new File(['bytes'], 'cover.png', { type: 'image/png' }))
    await user.type(screen.getByLabelText(/Description/), 'A tale of algorithms')
    await user.selectOptions(screen.getByLabelText(/Category/), 'Games')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await setDeadline(VALID_DEADLINE)
    await user.click(screen.getByRole('button', { name: 'Create' }))

    const calls = fetchMock.mock.calls as unknown[][]
    const metaInit = calls[3]?.[1] as { body?: unknown } | undefined
    expect(metaInit?.body).toContain('"name":"My first novel"')
    expect(metaInit?.body).toContain('"description":"A tale of algorithms"')
    expect(metaInit?.body).toContain('"image":"ipfs://QmCover"')
    expect(metaInit?.body).toContain('"category":"Games"')
    expect(createCampaignMock).toHaveBeenCalledWith(
      { address: 'ADDRESS', signer: {} },
      'My first novel',
      'ipfs://QmMeta',
      expect.anything(),
      VALID_DEADLINE,
    )
    expect(onCreated).toHaveBeenCalledWith(99n)
    // Cover and metadata share the one session: a single wallet signature.
    expect(signDataMock).toHaveBeenCalledTimes(1)
  })

  it('shows the app id and retries registration when registration fails', async () => {
    createCampaignMock.mockResolvedValue({
      appId: 99n,
      appAddress: 'ESCROW',
      registered: false,
      registerError: 'not an official kasakame campaign',
    })
    registerCampaignMock.mockResolvedValue(undefined)
    const onCreated = vi.fn()
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={onCreated} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Campaign created as app #99/)).toBeInTheDocument()
    expect(onCreated).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Retry registration' }))

    expect(registerCampaignMock).toHaveBeenCalledWith(99n, { address: 'ADDRESS', signer: {} })
    expect(onCreated).toHaveBeenCalledWith(99n)
  })

  it('keeps the retry action when registration retry fails', async () => {
    createCampaignMock.mockResolvedValue({ appId: 99n, appAddress: 'ESCROW', registered: false })
    registerCampaignMock.mockRejectedValue(new Error('boom'))
    const onCreated = vi.fn()
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={onCreated} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await user.click(await screen.findByRole('button', { name: 'Retry registration' }))

    expect(await screen.findByText(/Registration for app #99 still failed/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry registration' })).toBeInTheDocument()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('creates a campaign without a cover', async () => {
    createCampaignMock.mockResolvedValue({ appId: 99n, appAddress: 'ESCROW', registered: true })
    const onCreated = vi.fn()
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={onCreated} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(createCampaignMock).toHaveBeenCalledWith(
      { address: 'ADDRESS', signer: {} },
      'My first novel',
      '',
      expect.anything(),
      VALID_DEADLINE,
    )
    expect(onCreated).toHaveBeenCalledWith(99n)
    expect(signDataMock).not.toHaveBeenCalled()
  })

  it('shows an error for a zero goal', async () => {
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '0')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Goal must be greater than zero/)).toBeInTheDocument()
  })

  it('shows an error for a goal above the total ALGO supply', async () => {
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10000000001')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Goal must be 10 billion ALGO or less/)).toBeInTheDocument()
  })

  it('shows an error for a title longer than 123 bytes', async () => {
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'x'.repeat(124))
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Title must be 123 bytes or fewer/)).toBeInTheDocument()
  })

  it('shows an error when the uploaded URI is longer than 117 bytes', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ nonce: 'cover-nonce' }) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ cid: 'QmCover' }) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ cid: `Q${'x'.repeat(200)}` }) }),
    )
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.upload(screen.getByLabelText(/Choose cover/), new File(['bytes'], 'cover.png', { type: 'image/png' }))
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Metadata URI must be 117 bytes or fewer/)).toBeInTheDocument()
  })

  it('rejects a deadline below the one-day minimum', async () => {
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await setDeadline(CHAIN_NOW + 86_400n)
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/End date must be at least 1 day from now/)).toBeInTheDocument()
    expect(createCampaignMock).not.toHaveBeenCalled()
  })

  it('accepts a deadline at the picker minimum', async () => {
    createCampaignMock.mockResolvedValue({ appId: 99n, appAddress: 'ESCROW', registered: true })
    const onCreated = vi.fn()
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={onCreated} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    const atMinimum = CHAIN_NOW + 86_400n + 300n
    await setDeadline(atMinimum)
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(createCampaignMock).toHaveBeenCalledWith({ address: 'ADDRESS', signer: {} }, 'My first novel', '', 10_000_000n, atMinimum)
    expect(onCreated).toHaveBeenCalledWith(99n)
  })

  it('rejects a deadline above the 180-day maximum', async () => {
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await setDeadline(CHAIN_NOW + 180n * 86_400n + 60n)
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/End date must be 180 days or less from now/)).toBeInTheDocument()
    expect(createCampaignMock).not.toHaveBeenCalled()
  })

  it('sets the deadline picker bounds from the chain time', async () => {
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)
    const input = screen.getByLabelText(/End date and time/)

    await waitFor(() => {
      expect(input).toHaveAttribute('min', toDateTimeLocal(CHAIN_NOW + 86_400n + 300n))
      expect(input).toHaveAttribute('max', toDateTimeLocal(CHAIN_NOW + 180n * 86_400n))
    })
  })

  it('sets a default deadline after loading the chain time', async () => {
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)
    const input = screen.getByLabelText(/End date and time/)

    await waitFor(() => {
      expect(input).toHaveValue(toDateTimeLocal(VALID_DEADLINE))
    })
  })

  it('shows a message when the chain time cannot be loaded', async () => {
    fetchChainTimestampMock.mockRejectedValueOnce(new Error('offline'))
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    expect(await screen.findByText(/Could not read the chain time/)).toBeInTheDocument()
  })

  it('uses the default deadline when the chain time failed on load', async () => {
    fetchChainTimestampMock.mockRejectedValueOnce(new Error('offline'))
    createCampaignMock.mockResolvedValue({ appId: 99n, appAddress: 'ESCROW', registered: true })
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    expect(await screen.findByText(/Could not read the chain time/)).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(createCampaignMock).toHaveBeenCalledWith({ address: 'ADDRESS', signer: {} }, 'My first novel', '', 10_000_000n, VALID_DEADLINE)
  })

  it('shows an error when creation fails', async () => {
    createCampaignMock.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Failed to create campaign/)).toBeInTheDocument()
  })

  it('suggests reconnecting when the wallet session is dead', async () => {
    createCampaignMock.mockRejectedValue(new Error('PeraWalletConnect was not initialized correctly.'))
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Connect your wallet again/)).toBeInTheDocument()
    expect(disconnectMock).toHaveBeenCalledOnce()
  })

  it('tells the user to reconnect manually when there is no wallet to clear', async () => {
    useWalletMock.mockReturnValue({ activeAddress: 'ADDRESS', activeWallet: null, transactionSigner: {} })
    createCampaignMock.mockRejectedValue(new Error('PeraWalletConnect was not initialized correctly.'))
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Disconnect and reconnect your wallet/)).toBeInTheDocument()
  })

  it('reports a rejection plainly and logs the failure', async () => {
    createCampaignMock.mockRejectedValue(new Error('Transaction rejected by user'))
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Transaction rejected in your wallet/)).toBeInTheDocument()
    expect(logErrorMock).toHaveBeenCalledWith('create', expect.any(Error))
  })

  it('calls onCancel', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={onCancel} />)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('signs canonical SIWA during create', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ cid: 'QmCover' }) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ cid: 'QmMeta' }) }),
    )
    createCampaignMock.mockResolvedValue({ appId: 99n, appAddress: 'ESCROW', registered: true })
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.upload(screen.getByLabelText(/Choose cover/), new File(['bytes'], 'cover.png', { type: 'image/png' }))
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    const calls = signDataMock.mock.calls as unknown[][]
    const payload = calls[0]?.[0] as string
    const siwa = JSON.parse(atob(payload)) as { nonce?: unknown; account_address?: unknown; chain_id?: unknown }
    expect(siwa.nonce).toBeTruthy()
    expect(siwa.account_address).toBe('ADDRESS')
    expect(siwa.chain_id).toBe('algorand:testnet')
    expect(signDataMock).toHaveBeenCalledWith(payload, { encoding: 'base64', scope: ScopeType.AUTH })
  })

  it('shows a message when the metadata upload fails', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ nonce: 'cover-nonce' }) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ cid: 'QmCover' }) })
        .mockResolvedValueOnce({ status: 400, json: () => Promise.resolve({}) }),
    )
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.upload(screen.getByLabelText(/Choose cover/), new File(['bytes'], 'cover.png', { type: 'image/png' }))
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Metadata pinning failed/)).toBeInTheDocument()
  })

  it('shows a message when the cover upload fails', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 400, json: () => Promise.resolve({}) }))
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.upload(screen.getByLabelText(/Choose cover/), new File(['bytes'], 'cover.png', { type: 'image/png' }))
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Could not start the upload/)).toBeInTheDocument()
  })

  it('shows a message when signing fails', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) }))
    signDataMock.mockRejectedValueOnce(new Error('rejected in wallet'))
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.upload(screen.getByLabelText(/Choose cover/), new File(['bytes'], 'cover.png', { type: 'image/png' }))
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/rejected in wallet/)).toBeInTheDocument()
  })

  it('shows a message when the backend is not configured', async () => {
    // Explicitly blank: the developer's own .env may set VITE_BACKEND_URL and Vite loads it into tests.
    vi.stubEnv('VITE_BACKEND_URL', '')
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.upload(screen.getByLabelText(/Choose cover/), new File(['bytes'], 'cover.png', { type: 'image/png' }))
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/VITE_BACKEND_URL/)).toBeInTheDocument()
  })

  it('shows and clears the chosen filename', async () => {
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)
    const picker = screen.getByLabelText(/Choose cover/)

    expect(screen.getByText('No file chosen')).toBeInTheDocument()
    await user.upload(picker, new File(['bytes'], 'cover.png', { type: 'image/png' }))
    expect(screen.getByText('cover.png')).toBeInTheDocument()
    Object.defineProperty(picker, 'files', { value: [], configurable: true })
    fireEvent.change(picker)
    expect(screen.getByText('No file chosen')).toBeInTheDocument()
  })
})
