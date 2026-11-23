/**
 * Off-chain campaign metadata (ARC-3-style JSON) pointed to by the 128-byte on-chain `metadataUri`; every field is optional and `image` may itself be an `ipfs://` URI.
 */

// Public gateway for `ipfs://` URIs: the demo Pinata dedicated gateway, since public gateway.pinata.cloud misses our pins and ipfs.io shut down in September 2026.
const IPFS_GATEWAY = 'https://green-cooperative-koi-991.mypinata.cloud/ipfs/'

export interface CampaignMetadata {
  name?: string | undefined
  description?: string | undefined
  image?: string | undefined
  category?: string | undefined
}

/**
 * Map an `ipfs://` URI onto the gateway; anything else passes through.
 *
 * @param uri The URI to resolve.
 * @returns Gateway URL for `ipfs://` URIs, the trimmed input otherwise.
 */
export function resolveIpfsUri(uri: string): string {
  const trimmed = uri.trim()
  if (trimmed.startsWith('ipfs://')) {
    return `${IPFS_GATEWAY}${trimmed.slice('ipfs://'.length)}`
  }
  return trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Pick the known string fields out of a parsed JSON blob; null when empty.
 *
 * @param json The parsed JSON value.
 * @returns The metadata, or null for non-objects and empty blobs.
 */
export function parseCampaignMetadata(json: unknown): CampaignMetadata | null {
  if (!isRecord(json)) return null
  const metadata: CampaignMetadata = {
    name: asOptionalString(json.name),
    description: asOptionalString(json.description),
    image: asOptionalString(json.image),
    category: asOptionalString(json.category),
  }
  return (metadata.name ?? metadata.description ?? metadata.image ?? metadata.category) ? metadata : null
}

/**
 * Fetch and parse the metadata blob; null on blank/unresolvable URIs and any failure, while raw image bytes become a synthetic `{ image }`.
 *
 * @param uri The `metadataUri` pointer.
 * @returns The parsed metadata, a synthetic `{ image }` for raw image bytes, or null when unavailable.
 */
export async function fetchCampaignMetadata(uri: string): Promise<CampaignMetadata | null> {
  if (!looksResolvable(uri)) return null
  try {
    const response = await fetch(resolveIpfsUri(uri))
    if (!response.ok) return null
    if ((response.headers.get('content-type') ?? '').startsWith('image/')) return { image: uri }
    return parseCampaignMetadata((await response.json()) as unknown)
  } catch {
    return null
  }
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i

/**
 * Best-effort image URL for a `metadataUri`: the blob's `image` field, or the URI itself when it points straight at an image file.
 *
 * @param metadataUri The `metadataUri` pointer.
 * @param metadata The fetched blob, if any.
 * @returns Resolved image URL, or null.
 */
export function resolveImageSrc(metadataUri: string, metadata: CampaignMetadata | null): string | null {
  if (metadata?.image) return resolveIpfsUri(metadata.image)
  if (IMAGE_EXTENSIONS.test(metadataUri.trim())) return resolveIpfsUri(metadataUri)
  return null
}

const MIN_CID_LENGTH = 32

/**
 * Whether a URI is worth a network round-trip: `ipfs://` pointers whose first segment is far shorter than any real CID (e.g. seed placeholders) can never resolve, so skip them silently.
 *
 * @param uri The `metadataUri` pointer.
 * @returns True when a fetch might succeed.
 */
export function looksResolvable(uri: string): boolean {
  const trimmed = uri.trim()
  if (!trimmed.startsWith('ipfs://')) return trimmed !== ''
  // split() always yields at least one segment; the fallback satisfies noUncheckedIndexedAccess.
  /* v8 ignore next */
  const firstSegment = trimmed.slice('ipfs://'.length).split('/')[0] ?? ''
  return firstSegment.length >= MIN_CID_LENGTH
}
