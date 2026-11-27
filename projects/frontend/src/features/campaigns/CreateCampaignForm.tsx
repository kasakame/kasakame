import {
  MAX_CAMPAIGN_DURATION_SECONDS,
  MAX_GOAL_MICRO_ALGOS,
  MAX_METADATA_URI_BYTES,
  MAX_TITLE_BYTES,
  MICRO_ALGOS_PER_ALGO,
  MIN_CAMPAIGN_DURATION_SECONDS,
  SECONDS_PER_DAY,
} from '@kasakame/constants'
import { useNetwork, useWallet } from '@txnlab/use-wallet-react'
import { useEffect, useState } from 'react'
import { fetchChainTimestamp } from '../../lib/algorand'
import { adaptSignData, adaptSignTransaction, backendUrl, uploadCover, uploadMetadata } from '../../lib/backend'
import { classifyError, errorMessage } from '../../lib/errors'
import { formatDeadline, parseAlgoToMicroAlgos, toDateTimeLocal } from '../../lib/format'
import { logError } from '../../lib/log'
import { ensureLiveSessionFor } from '../../lib/session'
import { createCampaign, disconnectQuietly, registerCampaign } from '../../lib/transaction'
import { getWalletManager } from '../../lib/wallets'

interface CreateCampaignFormProps {
  /** Called with the new app id after a successful create. */
  onCreated: (appId: bigint) => void
  onCancel: () => void
}

const CATEGORIES = ['Art', 'Music', 'Film', 'Games', 'Books', 'Tech']

// Keep in sync with Campaign.MIN_DURATION_SECONDS and MAX_DURATION_SECONDS.
const MIN_DURATION_DAYS = MIN_CAMPAIGN_DURATION_SECONDS / SECONDS_PER_DAY
const MAX_DURATION_DAYS = MAX_CAMPAIGN_DURATION_SECONDS / SECONDS_PER_DAY
const DEFAULT_DURATION_DAYS = 30
// The create transaction lands in a later block, so keep a margin over the 24-hour minimum.
const DEADLINE_BUFFER_SECONDS = 300
// 10 billion ALGO, the total supply.
const MAX_GOAL_ALGO = Number(MAX_GOAL_MICRO_ALGOS / MICRO_ALGOS_PER_ALGO)

/**
 * Parse a `datetime-local` value as a local date and time.
 *
 * @param value The input value.
 * @returns UNIX seconds, or undefined when the value is empty or invalid.
 */
function parseDeadline(value: string): bigint | undefined {
  if (value === '') return undefined
  return BigInt(Math.floor(new Date(value).getTime() / 1000))
}

const CreateCampaignForm = ({ onCreated, onCancel }: CreateCampaignFormProps) => {
  const { activeAddress, activeWallet, signData, signTransactions, transactionSigner } = useWallet()
  const { activeNetworkConfig } = useNetwork()
  const [title, setTitle] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [goal, setGoal] = useState('')
  const [deadline, setDeadline] = useState('')
  const [chainNow, setChainNow] = useState<bigint | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [unregistered, setUnregistered] = useState<{ appId: bigint } | null>(null)

  const canSubmit =
    title.trim() !== '' && goal.trim() !== '' && !busy && unregistered === null && Boolean(activeAddress && transactionSigner)

  useEffect(() => {
    void fetchChainTimestamp()
      .then((now) => {
        setChainNow(now)
        setDeadline(toDateTimeLocal(now + BigInt(DEFAULT_DURATION_DAYS * SECONDS_PER_DAY)))
      })
      .catch(() => {
        setMessage('Could not read the chain time. Reload the page and try again.')
      })
  }, [])

  const chosenDeadlinePreview = parseDeadline(deadline)
  const deadlinePreview = chosenDeadlinePreview === undefined ? undefined : formatDeadline(chosenDeadlinePreview)
  const minDeadline =
    chainNow === null ? undefined : toDateTimeLocal(chainNow + BigInt(MIN_DURATION_DAYS * SECONDS_PER_DAY + DEADLINE_BUFFER_SECONDS))
  const maxDeadline = chainNow === null ? undefined : toDateTimeLocal(chainNow + BigInt(MAX_DURATION_DAYS * SECONDS_PER_DAY))

  const handleCreateError = (error: unknown, fallback?: string) => {
    logError('create', error)
    const kind = classifyError(error)
    if (kind === 'session') {
      if (activeWallet) {
        void disconnectQuietly(activeWallet)
        setMessage('Wallet session expired. Connect your wallet again to continue.')
      } else {
        setMessage('Wallet session expired. Disconnect and reconnect your wallet, then try again.')
      }
    } else {
      setMessage(fallback ?? errorMessage(error, 'create'))
    }
  }

  const handleSubmit = async () => {
    // Defensive: the submit button is disabled while disconnected, so this is unreachable in the UI.
    /* v8 ignore next */
    if (!activeAddress) return

    setBusy(true)
    setMessage(null)
    try {
      await ensureLiveSessionFor(getWalletManager(), activeWallet)
      if (new TextEncoder().encode(title).length > MAX_TITLE_BYTES) {
        setMessage(`Title must be ${String(MAX_TITLE_BYTES)} bytes or fewer.`)
        return
      }
      const goalMicroAlgos = parseAlgoToMicroAlgos(goal)
      if (goalMicroAlgos <= 0n) {
        setMessage('Goal must be greater than zero.')
        return
      }
      if (goalMicroAlgos > MAX_GOAL_MICRO_ALGOS) {
        setMessage('Goal must be 10 billion ALGO or less.')
        return
      }
      const now = await fetchChainTimestamp()
      const chosenDeadline = parseDeadline(deadline) ?? now + BigInt(DEFAULT_DURATION_DAYS * SECONDS_PER_DAY)
      if (deadline === '') setDeadline(toDateTimeLocal(chosenDeadline))
      const minDeadline = now + BigInt(MIN_DURATION_DAYS * SECONDS_PER_DAY + DEADLINE_BUFFER_SECONDS)
      const maxDeadline = now + BigInt(MAX_DURATION_DAYS * SECONDS_PER_DAY)
      if (chosenDeadline < minDeadline) {
        setMessage('End date must be at least 1 day from now.')
        return
      }
      if (chosenDeadline > maxDeadline) {
        setMessage(`End date must be ${String(MAX_DURATION_DAYS)} days or less from now.`)
        return
      }

      let metadataUri = ''
      if (imageFile !== null) {
        try {
          const sign = adaptSignData(signData)
          const signTxn = adaptSignTransaction(signTransactions)
          const baseUrl = backendUrl()
          const address = activeAddress
          const chainId = activeNetworkConfig.caipChainId
          const coverUri = await uploadCover({ baseUrl, address, chainId, sign, signTxn, file: imageFile })
          metadataUri = await uploadMetadata({
            baseUrl,
            address,
            chainId,
            sign,
            signTxn,
            name: title.trim(),
            description: description.trim(),
            image: coverUri,
            category,
          })
        } catch (error) {
          setMessage((error as Error).message)
          return
        }
      }
      if (new TextEncoder().encode(metadataUri).length > MAX_METADATA_URI_BYTES) {
        setMessage(`Metadata URI must be ${String(MAX_METADATA_URI_BYTES)} bytes or fewer.`)
        return
      }

      const result = await createCampaign(
        { address: activeAddress, signer: transactionSigner },
        title.trim(),
        metadataUri.trim(),
        goalMicroAlgos,
        chosenDeadline,
      )
      if (!result.registered) {
        logError('create-register', result.registerError ?? 'registration failed')
        setUnregistered({ appId: result.appId })
        setMessage(`Campaign created as app #${result.appId.toString()}, but registration failed. Retry registration to finish.`)
        return
      }
      onCreated(result.appId)
    } catch (error) {
      handleCreateError(error)
    } finally {
      setBusy(false)
    }
  }

  const handleRetryRegistration = async () => {
    /* v8 ignore next -- the retry button only renders with a pending app id and a live signer */
    if (!unregistered || !activeAddress) return
    setBusy(true)
    setMessage(null)
    try {
      await ensureLiveSessionFor(getWalletManager(), activeWallet)
      await registerCampaign(unregistered.appId, { address: activeAddress, signer: transactionSigner })
      onCreated(unregistered.appId)
    } catch (error) {
      handleCreateError(error, `Registration for app #${unregistered.appId.toString()} still failed. Please try again.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-5 border-t border-line pt-5">
      <h3 className="m-0 mb-3 text-lg">Create a campaign</h3>
      <label className="mb-3 block text-sm text-muted">
        Title
        <input
          type="text"
          placeholder="e.g. My first novel"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
          }}
          className="mb-3 w-full rounded-md border border-line px-3 py-2 focus:border-teal focus:outline-none"
        />
      </label>
      <div className="mb-3 flex items-center gap-2">
        <label
          htmlFor="cover-file"
          className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark"
        >
          Choose cover
        </label>
        <input
          id="cover-file"
          type="file"
          accept="image/*"
          onChange={(e) => {
            // Change events always carry a FileList (possibly empty) - the cast only satisfies the nullable DOM type.
            const files = e.target.files as FileList
            setImageFile(files[0] ?? null)
          }}
          className="hidden"
        />
        <span className="min-w-0 flex-1 truncate text-sm text-muted">{imageFile?.name ?? 'No file chosen'}</span>
      </div>
      <label className="mb-3 block text-sm text-muted">
        Description (optional)
        <textarea
          placeholder="What is this campaign about?"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value)
          }}
          rows={3}
          className="mb-3 w-full rounded-md border border-line px-3 py-2 focus:border-teal focus:outline-none"
        />
      </label>
      <label className="mb-3 block text-sm text-muted">
        Category (optional)
        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value)
          }}
          className="mb-3 w-full rounded-md border border-line px-3 py-2 focus:border-teal focus:outline-none"
        >
          <option value="">Select a category</option>
          {CATEGORIES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="mb-3 block text-sm text-muted">
        Goal (ALGO)
        <input
          type="number"
          min="0"
          max={MAX_GOAL_ALGO}
          step="any"
          placeholder="e.g. 100"
          value={goal}
          onChange={(e) => {
            setGoal(e.target.value)
          }}
          className="mb-3 w-full rounded-md border border-line px-3 py-2 focus:border-teal focus:outline-none"
        />
      </label>
      <label className="mb-3 block text-sm text-muted">
        End date and time
        <input
          type="datetime-local"
          min={minDeadline}
          max={maxDeadline}
          value={deadline}
          onChange={(e) => {
            setDeadline(e.target.value)
          }}
          className="mb-1 w-full rounded-md border border-line px-3 py-2 focus:border-teal focus:outline-none"
        />
        <span className="block text-xs text-muted">
          {deadlinePreview === undefined ? 'Choose when the campaign ends.' : `Ends ${deadlinePreview}.`} Between 1 and 180 days from now.
        </span>
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
      {unregistered && (
        <button
          type="button"
          className="mt-3 cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy}
          onClick={() => void handleRetryRegistration()}
        >
          {busy ? 'Retrying…' : 'Retry registration'}
        </button>
      )}
      {message && <p className="mt-3 mb-0 text-sm text-muted">{message}</p>}
    </div>
  )
}

export default CreateCampaignForm
