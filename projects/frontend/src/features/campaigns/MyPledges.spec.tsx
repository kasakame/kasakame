import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CampaignHeader, CampaignViewModel } from '../../lib/campaign'
import MyPledges from './MyPledges'

const useWalletMock = vi.fn()
const enumerateCampaignsMock = vi.fn()
const fetchCampaignHeaderMock = vi.fn()
const fetchMyLeavesMock = vi.fn()
const fetchChainTimestampMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
}))

vi.mock('../../lib/algorand', () => ({
  fetchChainTimestamp: (...args: unknown[]) => fetchChainTimestampMock(...args),
}))

vi.mock('../../lib/campaign', async () => {
  const actual = await vi.importActual('../../lib/campaign')
  return {
    ...actual,
    enumerateCampaigns: (...args: unknown[]) => enumerateCampaignsMock(...args),
    fetchCampaignHeader: (...args: unknown[]) => fetchCampaignHeaderMock(...args),
    fetchMyLeaves: (...args: unknown[]) => fetchMyLeavesMock(...args),
  }
})

vi.mock('./CampaignCard', () => ({
  default: ({ campaign, onSelect }: { campaign: CampaignViewModel; onSelect: (id: bigint) => void }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          onSelect(campaign.id)
        }}
      >
        CARD_{campaign.id.toString()}
      </button>
      <span>PLEDGE_{String(campaign.myPledgeMicroAlgos ?? 'none')}</span>
    </div>
  ),
}))

const nowSeconds = 1_000n

function header(id: bigint, overrides: Partial<CampaignHeader> = {}): CampaignHeader {
  return {
    id,
    creator: `CREATOR${id.toString()}`,
    title: `Campaign ${id.toString()}`,
    metadataUri: '',
    goalMicroAlgos: 10_000_000n,
    deadlineSeconds: nowSeconds + 1_000n,
    raisedMicroAlgos: 5_000_000n,
    status: 'open',
    deleted: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useWalletMock.mockReturnValue({ activeAddress: 'ADDRESS' })
  enumerateCampaignsMock.mockResolvedValue(new Set<bigint>())
  fetchCampaignHeaderMock.mockResolvedValue(undefined)
  fetchMyLeavesMock.mockResolvedValue([])
  fetchChainTimestampMock.mockResolvedValue(nowSeconds)
})

describe('MyPledges', () => {
  it('prompts to connect when disconnected and goes back', async () => {
    useWalletMock.mockReturnValue({ activeAddress: null })
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<MyPledges onSelectCampaign={() => {}} onBack={onBack} />)

    expect(screen.getByText(/Connect your wallet to see your pledges/)).toBeInTheDocument()
    expect(enumerateCampaignsMock).not.toHaveBeenCalled()

    await user.click(screen.getByText('← Back'))
    expect(onBack).toHaveBeenCalled()
  })

  it('reloads when the wallet connects', async () => {
    useWalletMock.mockReturnValue({ activeAddress: null })
    const { rerender } = render(<MyPledges onSelectCampaign={() => {}} onBack={() => {}} />)

    expect(screen.getByText(/Connect your wallet/)).toBeInTheDocument()

    useWalletMock.mockReturnValue({ activeAddress: 'ADDRESS' })
    enumerateCampaignsMock.mockResolvedValue(new Set([1n]))
    fetchCampaignHeaderMock.mockResolvedValue(header(1n))
    fetchMyLeavesMock.mockResolvedValue([{ position: 0, amount: 250_000n, txidHex: 'aa' }])
    rerender(<MyPledges onSelectCampaign={() => {}} onBack={() => {}} />)

    expect(await screen.findByText('CARD_1')).toBeInTheDocument()
  })

  it('renders an empty state when no campaign has live leaves', async () => {
    enumerateCampaignsMock.mockResolvedValue(new Set([1n]))
    fetchCampaignHeaderMock.mockResolvedValue(header(1n))
    render(<MyPledges onSelectCampaign={() => {}} onBack={() => {}} />)

    expect(await screen.findByText(/No live pledges yet/)).toBeInTheDocument()
  })

  it('shows campaigns with live leaves, deleted ones included, and skips the rest', async () => {
    enumerateCampaignsMock.mockResolvedValue(new Set([1n, 2n, 9n]))
    fetchCampaignHeaderMock.mockImplementation((id: bigint) => {
      if (id === 9n) return Promise.resolve(header(9n, { deleted: true, status: 'claimed' }))
      return Promise.resolve(header(id))
    })
    fetchMyLeavesMock.mockImplementation((id: bigint) => {
      if (id === 1n) {
        return Promise.resolve([
          { position: 0, amount: 250_000n, txidHex: 'aa' },
          { position: 3, amount: 150_000n, txidHex: 'bb' },
        ])
      }
      if (id === 9n) return Promise.resolve([{ position: 1, amount: 1_000_000n, txidHex: 'cc' }])
      return Promise.resolve([])
    })
    render(<MyPledges onSelectCampaign={() => {}} onBack={() => {}} />)

    expect(await screen.findByText('CARD_1')).toBeInTheDocument()
    expect(fetchMyLeavesMock).toHaveBeenCalledWith(1n, 'ADDRESS')
    expect(fetchMyLeavesMock).toHaveBeenCalledWith(9n, 'ADDRESS')
    expect(screen.getByText('PLEDGE_400000')).toBeInTheDocument()
    expect(screen.getByText('CARD_9')).toBeInTheDocument()
    expect(screen.getByText('PLEDGE_1000000')).toBeInTheDocument()
    expect(screen.queryByText('CARD_2')).not.toBeInTheDocument()
  })

  it('orders open campaigns by soonest deadline before the settled ones', async () => {
    enumerateCampaignsMock.mockResolvedValue(new Set([1n, 2n, 3n, 4n, 5n, 6n]))
    fetchCampaignHeaderMock.mockImplementation((id: bigint) => {
      if (id === 1n) return Promise.resolve(header(id, { deadlineSeconds: nowSeconds + 2_000n }))
      if (id === 2n || id === 3n) return Promise.resolve(header(id, { deadlineSeconds: nowSeconds + 1_000n }))
      if (id === 4n) return Promise.resolve(header(id, { deadlineSeconds: nowSeconds - 1n, raisedMicroAlgos: 1_000_000n }))
      if (id === 6n) return Promise.resolve(header(id, { deadlineSeconds: nowSeconds + 1_500n }))
      return Promise.resolve(header(id, { status: 'claimed' }))
    })
    fetchMyLeavesMock.mockResolvedValue([{ position: 0, amount: 250_000n, txidHex: 'aa' }])
    render(<MyPledges onSelectCampaign={() => {}} onBack={() => {}} />)

    await screen.findByText('CARD_5')
    const order = screen.getAllByText(/^CARD_\d+$/).map((element) => element.textContent)
    expect([...order.slice(0, 2)].sort()).toEqual(['CARD_2', 'CARD_3'])
    expect(order.slice(2)).toEqual(['CARD_6', 'CARD_1', 'CARD_4', 'CARD_5'])
  })

  it('skips campaigns whose reads fail', async () => {
    enumerateCampaignsMock.mockResolvedValue(new Set([1n, 2n, 3n, 4n]))
    fetchCampaignHeaderMock.mockImplementation((id: bigint) => {
      if (id === 2n) return Promise.reject(new Error('offline'))
      if (id === 3n) return Promise.resolve(undefined)
      return Promise.resolve(header(id))
    })
    fetchMyLeavesMock.mockImplementation((id: bigint) => {
      if (id === 3n) return Promise.reject(new Error('offline'))
      return Promise.resolve([{ position: 0, amount: 250_000n, txidHex: 'aa' }])
    })
    render(<MyPledges onSelectCampaign={() => {}} onBack={() => {}} />)

    expect(await screen.findByText('CARD_1')).toBeInTheDocument()
    expect(screen.getByText('CARD_4')).toBeInTheDocument()
    expect(screen.queryByText('CARD_2')).not.toBeInTheDocument()
    expect(screen.queryByText('CARD_3')).not.toBeInTheDocument()
  })

  it('renders an error state when the scan fails', async () => {
    enumerateCampaignsMock.mockRejectedValue(new Error('offline'))
    render(<MyPledges onSelectCampaign={() => {}} onBack={() => {}} />)

    expect(await screen.findByText(/Failed to load your pledges/)).toBeInTheDocument()
  })

  it('keeps the loading state while the first replays are still running', async () => {
    enumerateCampaignsMock.mockResolvedValue(new Set([1n, 2n]))
    fetchCampaignHeaderMock.mockResolvedValue(header(1n))
    let resolveLeaves: ((value: { position: number; amount: bigint; txidHex: string }[]) => void) | undefined
    fetchMyLeavesMock.mockImplementation((id: bigint) => {
      if (id === 1n) {
        return new Promise<{ position: number; amount: bigint; txidHex: string }[]>((resolve) => {
          resolveLeaves = resolve
        })
      }
      return Promise.resolve([])
    })
    render(<MyPledges onSelectCampaign={() => {}} onBack={() => {}} />)

    expect(await screen.findByText(/Loading your pledges/)).toBeInTheDocument()

    if (resolveLeaves === undefined) throw new Error('leaves were not requested')
    resolveLeaves([{ position: 0, amount: 250_000n, txidHex: 'aa' }])
    expect(await screen.findByText('CARD_1')).toBeInTheDocument()
    expect(screen.queryByText(/Loading your pledges/)).not.toBeInTheDocument()
  })

  it('opens a campaign from its card', async () => {
    enumerateCampaignsMock.mockResolvedValue(new Set([1n]))
    fetchCampaignHeaderMock.mockResolvedValue(header(1n))
    fetchMyLeavesMock.mockResolvedValue([{ position: 0, amount: 250_000n, txidHex: 'aa' }])
    const onSelectCampaign = vi.fn()
    const user = userEvent.setup()
    render(<MyPledges onSelectCampaign={onSelectCampaign} onBack={() => {}} />)

    await user.click(await screen.findByText('CARD_1'))
    expect(onSelectCampaign).toHaveBeenCalledWith(1n)
  })

  it('does not update state when unmounted before the scan resolves', async () => {
    let resolveEnumerate: ((value: Set<bigint>) => void) | undefined
    enumerateCampaignsMock.mockReturnValue(
      new Promise<Set<bigint>>((resolve) => {
        resolveEnumerate = resolve
      }),
    )
    const { unmount } = render(<MyPledges onSelectCampaign={() => {}} onBack={() => {}} />)
    // Let the effect reach the scan before unmounting.
    await new Promise((r) => setTimeout(r, 0))
    unmount()

    resolveEnumerate?.(new Set([1n]))
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchCampaignHeaderMock).not.toHaveBeenCalled()
  })

  it('does not update state when unmounted before the scan rejects', async () => {
    let rejectEnumerate: ((reason: unknown) => void) | undefined
    enumerateCampaignsMock.mockReturnValue(
      new Promise<Set<bigint>>((_, reject) => {
        rejectEnumerate = reject
      }),
    )
    const { unmount } = render(<MyPledges onSelectCampaign={() => {}} onBack={() => {}} />)
    await new Promise((r) => setTimeout(r, 0))
    unmount()

    await new Promise((r) => setTimeout(r, 0))
    rejectEnumerate?.(new Error('offline'))
    expect(screen.queryByText(/Failed to load your pledges/)).not.toBeInTheDocument()
  })

  it('does not merge results when unmounted mid-scan', async () => {
    enumerateCampaignsMock.mockResolvedValue(new Set([1n]))
    fetchCampaignHeaderMock.mockResolvedValue(header(1n))
    let resolveLeaves: ((value: { position: number; amount: bigint; txidHex: string }[]) => void) | undefined
    fetchMyLeavesMock.mockReturnValue(
      new Promise<{ position: number; amount: bigint; txidHex: string }[]>((resolve) => {
        resolveLeaves = resolve
      }),
    )
    const { unmount } = render(<MyPledges onSelectCampaign={() => {}} onBack={() => {}} />)
    await waitFor(() => {
      expect(fetchMyLeavesMock).toHaveBeenCalledWith(1n, 'ADDRESS')
    })
    unmount()

    if (resolveLeaves === undefined) throw new Error('leaves were not requested')
    resolveLeaves([{ position: 0, amount: 250_000n, txidHex: 'aa' }])
    await new Promise((r) => setTimeout(r, 0))
  })
})
