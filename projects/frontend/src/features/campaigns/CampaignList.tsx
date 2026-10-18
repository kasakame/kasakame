import { useWallet } from '@txnlab/use-wallet-react'
import { useEffect, useState } from 'react'
import type { CampaignHeader, CampaignViewModel } from '../../lib/campaign'
import {
  campaignFromHeader,
  enumerateCampaigns,
  fetchCampaignHeader,
  fetchMyPledge,
  getCachedCampaigns,
  listCampaigns,
} from '../../lib/campaign'
import CampaignCard from './CampaignCard'

interface CampaignListProps {
  /** Set when the user opens a specific campaign (state-based navigation). */
  onSelectCampaign: (id: bigint) => void
}

const CampaignList = ({ onSelectCampaign }: CampaignListProps) => {
  const { activeAddress } = useWallet()
  const [campaigns, setCampaigns] = useState<CampaignViewModel[]>([])
  const [deletedCampaigns, setDeletedCampaigns] = useState<CampaignViewModel[]>([])
  const [nowSeconds, setNowSeconds] = useState<bigint | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    // Deleted campaigns no longer appear in the Factory registry; the registry + vault-box enumeration finds them.
    // Only the ones still holding backer refunds are worth rendering.
    const loadDeleted = async (liveCampaigns: CampaignViewModel[], now: bigint) => {
      try {
        const all = await enumerateCampaigns()
        const live = new Set(liveCampaigns.map((campaign) => campaign.id))
        const headers = await Promise.all(
          [...all].filter((id) => !live.has(id)).map((id) => fetchCampaignHeader(id).catch(() => undefined)),
        )
        const deleted = headers
          .filter((header): header is CampaignHeader => header !== undefined && header.deleted && header.raisedMicroAlgos > 0n)
          .map((header) => campaignFromHeader(header, now))
        if (!cancelled) setDeletedCampaigns(deleted)
      } catch {
        // Supplementary section: a failed enumeration omits it, the live list still renders.
      }
    }

    // Fast pass without the viewer: cards render from global state alone (~0.2s for the whole list).
    // Pledge totals need a full history replay each, so they stream in afterwards without blocking.
    // A cached base list paints instantly with no spinner; the refresh below replaces it either way.
    const cached = getCachedCampaigns()
    if (cached) {
      setNowSeconds(cached.nowSeconds)
      setCampaigns(cached.campaigns)
      setLoading(false)
    } else {
      setLoading(true)
    }
    listCampaigns()
      .then((result) => {
        if (!cancelled) {
          setNowSeconds(result.nowSeconds)
          setCampaigns(result.campaigns)
          void loadDeleted(result.campaigns, result.nowSeconds)
          if (activeAddress) {
            const viewer = activeAddress
            void Promise.all(
              result.campaigns.map(async (campaign) => {
                const total = await fetchMyPledge(campaign.id, viewer).catch(() => undefined)
                if (!cancelled && total !== undefined) {
                  setCampaigns((previous) =>
                    previous.map((existing) => (existing.id === campaign.id ? { ...existing, myPledgeMicroAlgos: total } : existing)),
                  )
                }
              }),
            )
          }
        }
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load campaigns. Is the indexer reachable?')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeAddress])

  if (loading) {
    return (
      <div>
        <p className="text-muted">Loading campaigns…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <p className="text-badge-failed">{error}</p>
      </div>
    )
  }

  // A finished load with no error always sets the timestamp: reaching here with null means a logic bug.
  /* v8 ignore next */
  if (nowSeconds === null) {
    return (
      <div>
        <p className="text-muted">Loading campaigns…</p>
      </div>
    )
  }

  return (
    <div>
      {campaigns.length === 0 ? (
        <p className="text-muted">No campaigns yet. Create the first one!</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
          {campaigns.map((campaign) => (
            <CampaignCard key={campaign.id.toString()} campaign={campaign} nowSeconds={nowSeconds} onSelect={onSelectCampaign} />
          ))}
        </div>
      )}
      {deletedCampaigns.length > 0 && (
        <section className="mt-8">
          <h2 className="m-0 mb-1 text-xl">Deleted campaigns</h2>
          <p className="mt-0 mb-4 text-sm text-muted">
            These campaigns were removed on-chain; their unrefunded pledges stay refundable from the vault until each refund window closes.
          </p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
            {deletedCampaigns.map((campaign) => (
              <CampaignCard key={campaign.id.toString()} campaign={campaign} nowSeconds={nowSeconds} onSelect={onSelectCampaign} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

export default CampaignList
