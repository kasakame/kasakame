import { useNetwork, useWallet } from '@txnlab/use-wallet-react'
import { useEffect, useState } from 'react'
import { adaptSignData, adaptSignTransaction } from '../../lib/backend'
import { fetchMyProfile, saveProfile } from '../../lib/profiles'
import { ellipseAddress } from '../../utils/ellipseAddress'
import { orEmpty } from '../../utils/orEmpty'

interface ProfileProps {
  onBack: () => void
}

const Profile = ({ onBack }: ProfileProps) => {
  const { activeAddress, signData, signTransactions } = useWallet()
  const { activeNetworkConfig } = useNetwork()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')
  const [avatarCid, setAvatarCid] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [baseline, setBaseline] = useState<{ display_name: string; bio: string; avatar_cid: string; email: string }>({
    display_name: '',
    bio: '',
    avatar_cid: '',
    email: '',
  })

  useEffect(() => {
    if (!activeAddress) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(null)
    let cancelled = false

    void fetchMyProfile({
      address: activeAddress,
      chainId: activeNetworkConfig.caipChainId,
      sign: adaptSignData(signData),
      signTxn: adaptSignTransaction(signTransactions),
    })
      .then((p) => {
        if (!cancelled) {
          const loaded = {
            display_name: orEmpty(p?.display_name ?? null),
            bio: orEmpty(p?.bio ?? null),
            avatar_cid: orEmpty(p?.avatar_cid ?? null),
            email: orEmpty(p?.email ?? null),
          }
          setBaseline(loaded)
          if (p) {
            setDisplayName(loaded.display_name)
            setBio(loaded.bio)
            setAvatarCid(loaded.avatar_cid)
            setEmail(loaded.email)
          }
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load your profile. Please try again.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeAddress, activeNetworkConfig.caipChainId, signData, signTransactions, reloadKey])

  const handleSave = async () => {
    // Defensive: the form only renders while connected, so this is unreachable in the UI.
    /* v8 ignore next */
    if (!activeAddress) {
      setError('Wallet not connected.')
      return
    }
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const changes: { displayName?: string; bio?: string; avatarCid?: string; email?: string } = {}
      if (displayName !== baseline.display_name) changes.displayName = displayName
      if (bio !== baseline.bio) changes.bio = bio
      if (avatarCid !== baseline.avatar_cid) changes.avatarCid = avatarCid
      if (email !== baseline.email) changes.email = email
      if (Object.keys(changes).length === 0) {
        setSuccess('No changes.')
        return
      }
      const updated = await saveProfile({
        address: activeAddress,
        chainId: activeNetworkConfig.caipChainId,
        sign: adaptSignData(signData),
        signTxn: adaptSignTransaction(signTransactions),
        ...changes,
      })
      const saved = {
        display_name: orEmpty(updated.display_name),
        bio: orEmpty(updated.bio),
        avatar_cid: orEmpty(updated.avatar_cid),
        email: orEmpty(updated.email),
      }
      setBaseline(saved)
      setDisplayName(saved.display_name)
      setBio(saved.bio)
      setAvatarCid(saved.avatar_cid)
      setEmail(saved.email)
      setSuccess('Profile saved.')
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!activeAddress) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <p className="text-muted">Connect your wallet to view your profile.</p>
        <button
          type="button"
          className="mt-4 cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark"
          onClick={onBack}
        >
          Back
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Profile</h1>
        <button type="button" className="cursor-pointer text-sm text-muted hover:text-ink" onClick={onBack}>
          ← Back
        </button>
      </div>

      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-muted">Address</label>
          <div className="rounded bg-muted/20 px-3 py-2 font-mono text-sm">{ellipseAddress(activeAddress)}</div>
        </div>

        <div>
          <label htmlFor="displayName" className="mb-1 block text-sm text-muted">
            Display Name
          </label>
          <input
            id="displayName"
            type="text"
            maxLength={64}
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value)
            }}
            className="w-full rounded-md border border-line bg-card px-3 py-2 text-sm focus:border-teal focus:ring-1 focus:ring-teal focus:outline-none"
            placeholder="Your name"
          />
        </div>

        <div>
          <label htmlFor="bio" className="mb-1 block text-sm text-muted">
            Bio
          </label>
          <textarea
            id="bio"
            maxLength={1000}
            value={bio}
            onChange={(e) => {
              setBio(e.target.value)
            }}
            rows={3}
            className="w-full resize-none rounded-md border border-line bg-card px-3 py-2 text-sm focus:border-teal focus:ring-1 focus:ring-teal focus:outline-none"
            placeholder="Tell us about yourself"
          />
        </div>

        <div>
          <label htmlFor="avatarCid" className="mb-1 block text-sm text-muted">
            Avatar CID (IPFS)
          </label>
          <input
            id="avatarCid"
            type="text"
            maxLength={128}
            value={avatarCid}
            onChange={(e) => {
              setAvatarCid(e.target.value)
            }}
            className="w-full rounded-md border border-line bg-card px-3 py-2 text-sm focus:border-teal focus:ring-1 focus:ring-teal focus:outline-none"
            placeholder="Qm... (optional)"
          />
        </div>

        <div>
          <label htmlFor="email" className="mb-1 block text-sm text-muted">
            Email (for notifications)
          </label>
          <input
            id="email"
            type="email"
            maxLength={320}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
            }}
            className="w-full rounded-md border border-line bg-card px-3 py-2 text-sm focus:border-teal focus:ring-1 focus:ring-teal focus:outline-none"
            placeholder="you@example.com (optional)"
          />
        </div>

        {loadError && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            <span>{loadError}</span>
            <button
              type="button"
              className="cursor-pointer rounded-md border border-danger px-3 py-1 text-xs text-danger hover:bg-danger/10"
              onClick={() => {
                setReloadKey((key) => key + 1)
              }}
            >
              Retry
            </button>
          </div>
        )}
        {error && <div className="text-sm text-danger">{error}</div>}
        {success && <div className="text-sm text-teal-dark">{success}</div>}

        <button
          type="button"
          disabled={saving || loading}
          className="w-full cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save Profile'}
        </button>
      </div>
    </div>
  )
}

export default Profile
