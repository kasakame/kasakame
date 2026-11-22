import { CAMPAIGN_STATUS_CLAIMED, CAMPAIGN_STATUS_FAILED, CAMPAIGN_STATUS_OPEN } from '@kasakame/constants'
import type algosdk from 'algosdk'
import { encodeAddress } from 'algosdk'
import { u64beDecode } from '../claim-tree/index.js'

/**
 * Decode a box name carrying an 8-byte big-endian app id after a single-byte prefix.
 *
 * @param name Box name bytes.
 * @param prefix Expected first byte ('r' for registry, 'c' for vault).
 * @returns The campaign app id, or undefined when the name doesn't match.
 */
export function decodeBoxAppId(name: Uint8Array, prefix: number): bigint | undefined {
  if (name.length !== 9 || name[0] !== prefix) return undefined
  let id = 0n
  for (let i = 1; i <= 8; i++) {
    /* v8 ignore next */
    id = (id << 8n) | BigInt(name[i] ?? 0)
  }
  return id
}

/** The global-state key names this contract materialises. */
const KNOWN_KEYS = ['creator', 'title', 'metadataUri', 'goal', 'deadline', 'raised', 'status', 'root', 'n'] as const

const utf8 = new TextDecoder()

function decodeKey(keyBytes: Uint8Array): string {
  return utf8.decode(keyBytes)
}

/**
 * Extract the contract's global state from an indexer `Application` into a plain object. Unknown keys are ignored so other apps are safely
 * filtered out.
 *
 * @param app Indexer application with the campaign's global state.
 * @returns Decoded global-state values.
 */
export function decodeGlobalState(app: algosdk.indexerModels.Application): {
  creator?: string
  title?: string
  metadataUri?: string
  goal?: bigint
  deadline?: bigint
  raised?: bigint
  status?: bigint
} {
  const result: {
    creator?: string
    title?: string
    metadataUri?: string
    goal?: bigint
    deadline?: bigint
    raised?: bigint
    status?: bigint
  } = {}

  for (const kv of app.params.globalState ?? []) {
    const key = decodeKey(kv.key)
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) continue

    if (key === 'creator') {
      result.creator = encodeAddress(kv.value.bytes)
    } else if (key === 'title') {
      result.title = utf8.decode(kv.value.bytes)
    } else if (key === 'metadataUri') {
      result.metadataUri = utf8.decode(kv.value.bytes)
    } else if (key === 'goal') {
      result.goal = kv.value.uint
    } else if (key === 'deadline') {
      result.deadline = kv.value.uint
    } else if (key === 'raised') {
      result.raised = kv.value.uint
    } else if (key === 'status') {
      result.status = kv.value.uint
    }
  }

  return result
}

/**
 * True when an indexer `Application` looks like a `Campaign` (has our global-state keys).
 *
 * @param app Indexer application to check.
 * @returns True when the app exposes all known campaign global-state keys.
 */
export function isCampaignApp(app: algosdk.indexerModels.Application): boolean {
  const keys = new Set((app.params.globalState ?? []).map((kv) => decodeKey(kv.key)))
  return (KNOWN_KEYS as readonly string[]).every((key) => keys.has(key))
}

/**
 * Map a raw campaign status to its display word.
 *
 * @param status Raw on-chain status.
 * @returns The display status.
 */
export function campaignStatusFromRaw(status: bigint | undefined): 'open' | 'failed' | 'claimed' {
  if (status === CAMPAIGN_STATUS_OPEN) return 'open'
  if (status === CAMPAIGN_STATUS_FAILED) return 'failed'
  if (status === CAMPAIGN_STATUS_CLAIMED) return 'claimed'
  return 'open'
}

/**
 * Read a big-endian uint16 at offset.
 *
 * @param bytes The bytes to read from.
 * @param offset Offset of the uint16.
 * @returns The decoded value.
 */
function readU16BE(bytes: Uint8Array, offset: number): number {
  /* v8 ignore next - offset is always 0 with 2+ byte args in practice; the fallback satisfies noUncheckedIndexedAccess */
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

/**
 * Decode the ARC-56 tuple arguments of the Campaign `create` method call, selector already stripped:
 * `vault: uint64, title: byte[], metadataUri: byte[], goal: uint64, deadline: uint64`.
 *
 * `uint64` arguments (vault, goal, deadline) are 8 raw big-endian bytes; `byte[]` arguments carry a
 * 2-byte length prefix.
 *
 * @param args Application call args with the 4-byte method selector already removed.
 * @returns The decoded title, metadata URI, goal and deadline.
 */
export function decodeCreateArgs(args: Uint8Array[]): {
  title: string
  metadataUri: string
  goal: bigint
  deadline: bigint
} {
  // args[0] = vault (uint64); not needed in the header.
  const titleArg = args[1]
  const metadataUriArg = args[2]
  const goalArg = args[3]
  const deadlineArg = args[4]
  /* v8 ignore next - args.length >= 5 is guaranteed by the caller, so the fallback is unreachable */
  if (titleArg === undefined || metadataUriArg === undefined || goalArg === undefined || deadlineArg === undefined) {
    return { title: '', metadataUri: '', goal: 0n, deadline: 0n }
  }
  const titleLen = readU16BE(titleArg, 0)
  const uriLen = readU16BE(metadataUriArg, 0)
  return {
    title: utf8.decode(titleArg.slice(2, 2 + titleLen)),
    metadataUri: utf8.decode(metadataUriArg.slice(2, 2 + uriLen)),
    goal: u64beDecode(goalArg),
    deadline: u64beDecode(deadlineArg),
  }
}
