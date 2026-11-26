import type { SignTxn } from './backend'
import { backendUrl, ensureSession } from './backend'

/** A public creator profile as served by the backend; the email stays private. */
export interface UserProfile {
  address: string
  display_name: string | null
  bio: string | null
  avatar_cid: string | null
}

/** The owner's full profile, including the private email. */
export interface MyProfile extends UserProfile {
  email: string | null
}

/** Notification and display settings as served by the backend. */
export interface UserSettings {
  address: string
  notify_funded: boolean
  notify_failed: boolean
  theme: string
}

/** Inputs for saving a profile; omit a field to keep its stored value. */
export interface ProfileInput {
  address: string
  chainId: string | undefined
  sign: (payload: string) => Promise<{ signature: Uint8Array; authenticatorData: Uint8Array }>
  signTxn?: SignTxn | undefined
  displayName?: string
  bio?: string
  avatarCid?: string
  email?: string
}

/** Inputs for saving settings (see `saveSettings`). */
export interface SettingsInput {
  address: string
  chainId: string | undefined
  sign: (payload: string) => Promise<{ signature: Uint8Array; authenticatorData: Uint8Array }>
  signTxn?: SignTxn | undefined
  notifyFunded?: boolean
  notifyFailed?: boolean
  theme?: string
}

const cache = new Map<string, UserProfile | null>()
const settingsCache = new Map<string, UserSettings | null>()

/** Clear the cached profiles (tests). */
export function clearProfileCache(): void {
  cache.clear()
}

/** Clear the cached settings (tests). */
export function clearSettingsCache(): void {
  settingsCache.clear()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textField(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Fetch a creator profile, cached per address (missing profiles cache as null). Null without a backend.
 *
 * @param address Wallet address.
 * @returns The profile, or null when unset or unreachable.
 */
export async function fetchProfile(address: string): Promise<UserProfile | null> {
  const base = backendUrl()
  if (base === '' || address === '') return null
  const cached = cache.get(address)
  if (cached !== undefined) return cached
  let response: Response
  try {
    response = await fetch(`${base}/profiles?address=${encodeURIComponent(address)}`)
  } catch {
    throw new Error('Could not load the profile. Check your connection and try again.')
  }
  if (response.status === 404) {
    cache.set(address, null)
    return null
  }
  if (!response.ok) throw new Error('Could not load the profile. Please try again.')
  const json: unknown = await response.json()
  if (!isRecord(json)) throw new Error('Could not load the profile. Please try again.')
  const profile: UserProfile = {
    address,
    display_name: textField(json.display_name),
    bio: textField(json.bio),
    avatar_cid: textField(json.avatar_cid),
  }
  cache.set(address, profile)
  return profile
}

/**
 * Fetch the owner's full profile, including the private email, signing in first.
 *
 * @param input Fetch inputs.
 * @param input.address Backend address.
 * @param input.chainId CAIP-2 chain id for the SIWA request, if the network config provides one.
 * @param input.sign Wallet message signer (receives the base64 SIWA payload), returning raw signature bytes.
 * @param input.signTxn Transaction signer for wallets without message signing (universal sign-in fallback).
 * @returns The owner profile, or null when unset or unreachable.
 */
export async function fetchMyProfile({
  address,
  chainId,
  sign,
  signTxn,
}: {
  address: string
  chainId: string | undefined
  sign: (payload: string) => Promise<{ signature: Uint8Array; authenticatorData: Uint8Array }>
  signTxn?: SignTxn | undefined
}): Promise<MyProfile | null> {
  const base = backendUrl()
  if (base === '' || address === '') return null
  let token: string
  try {
    token = await ensureSession({
      baseUrl: base,
      address,
      chainId,
      sign,
      signTxn,
      statement: 'Sign in to kasakame to manage your profile.',
      action: 'profile fetch',
    })
  } catch {
    throw new Error('Could not load the profile. Check your connection and try again.')
  }
  let response: Response
  try {
    response = await fetch(`${base}/profiles/me`, { headers: { authorization: `Bearer ${token}` } })
  } catch {
    throw new Error('Could not load the profile. Check your connection and try again.')
  }
  if (response.status === 404) return null
  if (!response.ok) throw new Error('Could not load the profile. Please try again.')
  const json: unknown = await response.json()
  if (!isRecord(json)) throw new Error('Could not load the profile. Please try again.')
  return {
    address,
    display_name: textField(json.display_name),
    bio: textField(json.bio),
    avatar_cid: textField(json.avatar_cid),
    email: textField(json.email),
  }
}

/**
 * Fetch the caller's settings, cached per address; null without a backend, signing in to share the session cache.
 *
 * @param input Fetch inputs.
 * @param input.address Backend address.
 * @param input.chainId CAIP-2 chain id for the SIWA request, if the network config provides one.
 * @param input.sign Wallet message signer (receives the base64 SIWA payload), returning raw signature bytes.
 * @param input.signTxn Transaction signer for wallets without message signing (universal sign-in fallback).
 * @returns The settings, or null when unreachable.
 */
export async function fetchSettings({
  address,
  chainId,
  sign,
  signTxn,
}: {
  address: string
  chainId: string | undefined
  sign: (payload: string) => Promise<{ signature: Uint8Array; authenticatorData: Uint8Array }>
  signTxn?: SignTxn | undefined
}): Promise<UserSettings | null> {
  const base = backendUrl()
  if (base === '' || address === '') return null
  const cached = settingsCache.get(address)
  if (cached !== undefined) return cached
  let token: string
  try {
    token = await ensureSession({
      baseUrl: base,
      address,
      chainId,
      sign,
      signTxn,
      statement: 'Sign in to kasakame to manage your settings.',
      action: 'settings fetch',
    })
  } catch {
    throw new Error('Could not load settings. Check your connection and try again.')
  }
  let response: Response
  try {
    response = await fetch(`${base}/settings`, { headers: { authorization: `Bearer ${token}` } })
  } catch {
    throw new Error('Could not load settings. Check your connection and try again.')
  }
  if (!response.ok) throw new Error('Could not load settings. Please try again.')
  const json: unknown = await response.json()
  if (!isRecord(json)) throw new Error('Could not load settings. Please try again.')
  const settings: UserSettings = {
    address,
    notify_funded: json.notify_funded as boolean,
    notify_failed: json.notify_failed as boolean,
    theme: json.theme as string,
  }
  settingsCache.set(address, settings)
  return settings
}

/**
 * Save the caller's profile (blanks clear), signing in first.
 *
 * @param input Save inputs.
 * @param input.address Backend address.
 * @param input.chainId CAIP-2 chain id for the SIWA request, if the network config provides one.
 * @param input.sign Wallet message signer (receives the base64 SIWA payload), returning raw signature bytes.
 * @param input.signTxn Transaction signer for wallets without message signing (universal sign-in fallback).
 * @param input.displayName Display name, blank clears; omit to keep.
 * @param input.bio Bio text, blank clears; omit to keep.
 * @param input.avatarCid Avatar CID, blank clears; omit to keep.
 * @param input.email Email address, blank clears; omit to keep.
 * @returns The saved profile.
 */
export async function saveProfile({
  address,
  chainId,
  sign,
  signTxn,
  displayName,
  bio,
  avatarCid,
  email,
}: ProfileInput): Promise<MyProfile> {
  const body: Record<string, unknown> = {}
  if (displayName !== undefined) body.display_name = displayName === '' ? null : displayName
  if (bio !== undefined) body.bio = bio === '' ? null : bio
  if (avatarCid !== undefined) body.avatar_cid = avatarCid === '' ? null : avatarCid
  if (email !== undefined) body.email = email === '' ? null : email
  if (Object.keys(body).length === 0) throw new Error('Nothing to update.')

  const base = backendUrl()
  if (base === '') throw new Error('Profiles need the backend configured (VITE_BACKEND_URL).')
  const token = await ensureSession({
    baseUrl: base,
    address,
    chainId,
    sign,
    signTxn,
    statement: 'Sign in to kasakame to manage your profile.',
    action: 'profile update',
  })

  let response: Response
  try {
    response = await fetch(`${base}/profiles`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('Saving failed. Is the backend reachable?')
  }
  if (response.status !== 200) throw new Error('Saving failed. Try again.')
  const json: unknown = await response.json()
  if (!isRecord(json)) throw new Error('Saving failed. Try again.')
  const profile: MyProfile = {
    address,
    display_name: textField(json.display_name),
    bio: textField(json.bio),
    avatar_cid: textField(json.avatar_cid),
    email: textField(json.email),
  }
  cache.set(address, {
    address,
    display_name: profile.display_name,
    bio: profile.bio,
    avatar_cid: profile.avatar_cid,
  })
  return profile
}

/**
 * Save the caller's settings (notify prefs and theme; undefined keeps current), signing in first.
 *
 * @param input Save inputs.
 * @param input.address Backend address.
 * @param input.chainId CAIP-2 chain id for the SIWA request, if the network config provides one.
 * @param input.sign Wallet message signer (receives the base64 SIWA payload), returning raw signature bytes.
 * @param input.signTxn Transaction signer for wallets without message signing (universal sign-in fallback).
 * @param input.notifyFunded Whether to notify on funded campaigns.
 * @param input.notifyFailed Whether to notify on failed campaigns.
 * @param input.theme Theme setting.
 * @returns The saved settings.
 */
export async function saveSettings({
  address,
  chainId,
  sign,
  signTxn,
  notifyFunded,
  notifyFailed,
  theme,
}: SettingsInput): Promise<UserSettings> {
  const body: Record<string, unknown> = {}
  if (notifyFunded !== undefined) body.notify_funded = notifyFunded
  if (notifyFailed !== undefined) body.notify_failed = notifyFailed
  if (theme !== undefined) body.theme = theme
  if (Object.keys(body).length === 0) throw new Error('Nothing to update.')

  const base = backendUrl()
  if (base === '') throw new Error('Settings need the backend configured (VITE_BACKEND_URL).')
  const token = await ensureSession({
    baseUrl: base,
    address,
    chainId,
    sign,
    signTxn,
    statement: 'Sign in to kasakame to manage your settings.',
    action: 'settings update',
  })

  let response: Response
  try {
    response = await fetch(`${base}/settings`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('Saving failed. Is the backend reachable?')
  }
  if (response.status !== 200) throw new Error('Saving failed. Try again.')
  const json: unknown = await response.json()
  if (!isRecord(json)) throw new Error('Saving failed. Try again.')
  const settings: UserSettings = {
    address,
    notify_funded: json.notify_funded as boolean,
    notify_failed: json.notify_failed as boolean,
    theme: json.theme as string,
  }
  settingsCache.set(address, settings)
  return settings
}
