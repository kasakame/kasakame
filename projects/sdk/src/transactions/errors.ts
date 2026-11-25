import { clearTreeCache } from '../claim-tree/index.js'
import { CONTRACT_ERROR_MESSAGES } from '../generated/contract-errors.js'

/** Stable category of an SDK failure, driving retries and user-facing recovery. */
export type SdkErrorKind =
  'validation' | 'registry-mismatch' | 'stale-proof' | 'routing' | 'chain-state' | 'not-found' | 'network' | 'unknown'

/** SDK write operation that produced a failure. */
export type SdkOperation =
  | 'createCampaign'
  | 'registerCampaign'
  | 'verifyDeployment'
  | 'pledge'
  | 'cancelPledge'
  | 'refund'
  | 'claim'
  | 'deleteCampaign'
  | 'settleOpen'
  | 'releaseClaimed'
  | 'finalize'

/** Optional context attached to a classified failure. */
export interface SdkErrorContext {
  /** The operation that failed. */
  operation?: SdkOperation
  /** The campaign or other application the operation targeted. */
  appId?: bigint
  /** The transaction id the node reported, when known. */
  txId?: string
}

/** Constructor options for {@link SdkError}. */
export interface SdkErrorOptions extends SdkErrorContext {
  /** Stable assert code, derived from the contract message. */
  code?: string
  /** The original failure. */
  cause?: unknown
  /** Raw classifier input, kept for diagnostics and logging. */
  details?: unknown
}

/** Typed failure returned by SDK write helpers; the message is always the original failure text. */
export class SdkError extends Error {
  readonly kind: SdkErrorKind
  readonly code?: string
  readonly operation?: SdkOperation
  readonly appId?: bigint
  readonly txId?: string
  readonly cause?: unknown
  readonly details?: unknown

  /**
   * @param kind The failure category.
   * @param message The original failure message.
   * @param options Optional code, operation context, cause, and raw details.
   */
  constructor(kind: SdkErrorKind, message: string, options: SdkErrorOptions = {}) {
    super(message)
    this.name = 'SdkError'
    this.kind = kind
    if (options.code !== undefined) this.code = options.code
    if (options.operation !== undefined) this.operation = options.operation
    if (options.appId !== undefined) this.appId = options.appId
    if (options.txId !== undefined) this.txId = options.txId
    if (options.cause !== undefined) this.cause = options.cause
    if (options.details !== undefined) this.details = options.details
  }
}

// Codes the SDK acts on, plus messages whose text differs from the contract assert but means the same failure.
const MESSAGE_CODES: Readonly<Record<string, string>> = {
  'campaign already registered': 'campaign-already-registered',
  'campaign is not open': 'campaign-not-open',
  'campaign is not refundable': 'campaign-not-refundable',
  'creator cannot pledge to their own campaign': 'creator-self-pledge',
  'pledging is closed': 'pledging-closed',
  'deadline has not passed': 'deadline-not-passed',
  'refund window still open': 'refund-window-open',
  'refund window closed': 'refund-window-closed',
  'campaign reached maximum size': 'campaign-max-size',
  'campaign reached its maximum size; it can no longer accept pledges': 'campaign-max-size',
  'cancel would drop below goal in the final day': 'cancel-final-day-goal',
  'stale or forged frontier': 'stale-proof',
  'proof does not match root': 'stale-proof',
}

// Kinds that drive a retry; every other contract assert is chain state.
const KIND_BY_CODE: Readonly<Record<string, SdkErrorKind>> = {
  'stale-proof': 'stale-proof',
  'campaign-not-open': 'routing',
}

const NETWORK_PATTERN = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|network error|timeout|timed out/i
const NOT_FOUND_PATTERN = /application .*(?:not found|does not exist)/i

/**
 * Derive a stable code from a contract assert message.
 *
 * @param message The contract assert text.
 * @returns A lowercase hyphenated code.
 */
function slug(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Find the contract assert message inside a node or simulate error text.
 *
 * @param text The failure text.
 * @returns The most specific matching assert message, when any.
 */
function contractMessageFor(text: string): string | undefined {
  return CONTRACT_ERROR_MESSAGES.find((message) => text.includes(message))
}

/**
 * Resolve the stable code for a failure text.
 *
 * @param text The failure text, or the exact assert message.
 * @returns The explicit code, the generated slug, or undefined for a non-contract failure.
 */
function errorCodeFor(text: string): string | undefined {
  const explicit = MESSAGE_CODES[text]
  if (explicit !== undefined) return explicit
  const contractMessage = contractMessageFor(text)
  if (contractMessage === undefined) return undefined
  return MESSAGE_CODES[contractMessage] ?? slug(contractMessage)
}

/**
 * Extract the assert message and transaction id from an algokit-utils LogicError, if present.
 *
 * @param error The caught failure.
 * @returns The logic-error details, or undefined for another error shape.
 */
function logicDetails(error: unknown): { message: string; txId?: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const led: unknown = (error as { led?: unknown }).led
  if (typeof led !== 'object' || led === null) return undefined
  const message = (led as { msg?: unknown }).msg
  if (typeof message !== 'string') return undefined
  const txId = (led as { txId?: unknown }).txId
  return { message, ...(typeof txId === 'string' ? { txId } : {}) }
}

/**
 * Infer the failure kind from its text and code.
 *
 * @param text The failure text.
 * @param code The resolved assert code, if any.
 * @returns The failure category.
 */
function kindFor(text: string, code: string | undefined): SdkErrorKind {
  if (NOT_FOUND_PATTERN.test(text)) return 'not-found'
  if (NETWORK_PATTERN.test(text)) return 'network'
  if (code === undefined) return 'unknown'
  return KIND_BY_CODE[code] ?? 'chain-state'
}

/**
 * Classify a chain failure, preserving the original message.
 *
 * @param error The caught failure: a LogicError, a simulate error, or anything else.
 * @param context Optional operation and application context.
 * @returns The typed failure.
 */
export function classifyChainError(error: unknown, context: SdkErrorContext = {}): SdkError {
  if (error instanceof SdkError) return error
  const message = error instanceof Error ? error.message : String(error)
  const led = logicDetails(error)
  const text = led?.message ?? message
  const code = errorCodeFor(text)
  const txId = context.txId ?? led?.txId
  return new SdkError(kindFor(text, code), message, {
    ...(context.operation === undefined ? {} : { operation: context.operation }),
    ...(context.appId === undefined ? {} : { appId: context.appId }),
    ...(txId === undefined ? {} : { txId }),
    ...(code === undefined ? {} : { code }),
    cause: error,
    details: error,
  })
}

/**
 * Run a submission and classify its failure at the boundary.
 *
 * @param operation The write operation.
 * @param run The send call.
 * @param appId The application the write targets, when known.
 * @returns The send result.
 */
export async function submitWithClassification<T>(operation: SdkOperation, run: () => Promise<T>, appId?: bigint): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw classifyChainError(error, { operation, ...(appId === undefined ? {} : { appId }) })
  }
}

/**
 * Whether a submission failed on a stale Merkle proof (a concurrent pledge/refund moved the root).
 *
 * @param error The failure from a chain submission.
 * @returns True when rebuilding proofs and retrying once is correct.
 */
export function isStaleProofError(error: unknown): boolean {
  return classifyChainError(error).kind === 'stale-proof'
}

/**
 * Whether a refund failed because the campaign path stopped being valid (vault box settled, or campaign deleted) between the box read and the send.
 *
 * @param error The failure from a chain submission.
 * @returns True when re-reading the vault box and rebuilding the refund once is correct.
 */
export function isCampaignRoutingError(error: unknown): boolean {
  const kind = classifyChainError(error).kind
  return kind === 'routing' || kind === 'not-found'
}

/**
 * Whether registration failed because the campaign is already registered.
 *
 * @param error The failure from the registration send.
 * @returns True when the registration already landed and the failure is a retry race.
 */
export function isAlreadyRegisteredError(error: unknown): boolean {
  return classifyChainError(error).code === 'campaign-already-registered'
}

/**
 * Run a proof-carrying submission, rebuilding proofs once when the tree moved under us (concurrent pledge/refund changed the root between read and submit); anything else throws immediately.
 *
 * @param run Builds fresh proofs from a fresh tree, then submits. Called up to twice.
 * @param operation The write operation, attached to a classified failure.
 * @param appId The campaign application id.
 * @returns The result of the successful run.
 */
export async function submitWithFreshProof<T>(run: () => Promise<T>, operation: SdkOperation, appId: bigint): Promise<T> {
  const submit = async (): Promise<T> => {
    try {
      clearTreeCache()
      return await run()
    } catch (error) {
      throw classifyChainError(error, { operation, appId })
    }
  }
  try {
    return await submit()
  } catch (error) {
    if (error instanceof SdkError && error.kind === 'stale-proof') return await submit()
    throw error
  }
}
