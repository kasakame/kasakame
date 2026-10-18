import { useWallet } from '@txnlab/use-wallet-react'
import { useEffect, useState } from 'react'
import { fetchChainTimestamp } from '../../lib/algorand'
import type { CampaignStatus, CampaignViewModel } from '../../lib/campaign'
import { campaignFromHeader, enumerateCampaigns, fetchCampaignHeader, fetchMyLeaves } from '../../lib/campaign'
import CampaignCard from './CampaignCard'

interface MyPledgesProps {
  /** Set when the user opens a specific campaign (state-based navigation). */
  onSelectCampaign: (id: bigint) => void
  onBack: () => void
}

const STATUS_ORDER: Record<CampaignStatus, number> = { open: 0, failed: 1, successful: 2 }

/**
 * Open campaigns first (still cancellable), then failed (refundable), then successful; soonest deadline first within a group.
 *
 * @param left - One campaign view model.
 * @param right - The other campaign view model.
 * @returns Negative when `left` sorts first, positive when `right` does.
 */
function byStatusThenDeadline(left: CampaignViewModel, right: CampaignViewModel): number {
  const byStatus = STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
  if (byStatus !== 0) return byStatus
  if (left.deadlineSeconds === right.deadlineSeconds) return 0
  return left.deadlineSeconds < right.deadlineSeconds ? -1 : 1
}

const MyPledges = ({ onSelectCampaign, onBack }: MyPledgesProps) => {
  const { activeAddress } = useWallet()
  const [campaigns, setCampaigns] = useState<CampaignViewModel[]>([])
  const [nowSeconds, setNowSeconds] = useState<bigint | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!activeAddress) {
      setCampaigns([])
      setNowSeconds(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setCampaigns([])
    setNowSeconds(null)
    setLoading(true)
    setError(null)

    // One history replay per enumerated campaign; results stream in as each replay finishes. Deleted campaigns are
    // enumerated too: their vault refunds stay open until finalized, so their leaves are still live.
    const load = async () => {
      const [ids, now] = await Promise.all([enumerateCampaigns(), fetchChainTimestamp()])
      if (cancelled) return
      setNowSeconds(now)
      const found: CampaignViewModel[] = []
      await Promise.all(
        [...ids].map(async (id) => {
          try {
            const [header, leaves] = await Promise.all([fetchCampaignHeader(id), fetchMyLeaves(id, activeAddress)])
            if (header === undefined || leaves.length === 0) return
            const campaign = campaignFromHeader(header, now)
            campaign.myPledgeMicroAlgos = leaves.reduce((total, leaf) => total + leaf.amount, 0n)
            found.push(campaign)
            if (!cancelled) setCampaigns([...found].sort(byStatusThenDeadline))
          } catch {
            // A campaign whose reads fail is skipped; the other results still render.
          }
        }),
      )
    }

    void load()
      .catch(() => {
        if (!cancelled) setError('Failed to load your pledges. Is the indexer reachable?')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeAddress])

  const header = (
    <div className="mb-6 flex items-center justify-between">
      <h1 className="m-0 text-page-title">My Pledges</h1>
      <button type="button" className="cursor-pointer text-sm text-muted hover:text-ink" onClick={onBack}>
        ← Back
      </button>
    </div>
  )

  if (!activeAddress) {
    return (
      <div>
        {header}
        <p className="text-muted">Connect your wallet to see your pledges.</p>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        {header}
        <p className="text-badge-failed">{error}</p>
      </div>
    )
  }

  if (loading && campaigns.length === 0) {
    return (
      <div>
        {header}
        <p className="text-muted">Loading your pledges…</p>
      </div>
    )
  }

  // A finished load sets the timestamp before any campaign renders: reaching here with null means a logic bug.
  /* v8 ignore next */
  if (nowSeconds === null) {
    return (
      <div>
        {header}
        <p className="text-muted">Loading your pledges…</p>
      </div>
    )
  }

  return (
    <div>
      {header}
      {campaigns.length === 0 ? (
        <p className="text-muted">No live pledges yet. Back a campaign and it will show up here.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
          {campaigns.map((campaign) => (
            <CampaignCard key={campaign.id.toString()} campaign={campaign} nowSeconds={nowSeconds} onSelect={onSelectCampaign} />
          ))}
        </div>
      )}
    </div>
  )
}

export default MyPledges
