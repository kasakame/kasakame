import { clearTreeCache } from '../claim-tree/index.js'
import { CONTRACT_ERROR_MESSAGES } from '../generated/contract-errors.js'
import { sdkLogger } from '../log.js'
import type { WriteConfirmation } from './confirmation.js'

/** Stable category of an SDK failure, driving retries and user-facing recovery. */
export type SdkErrorType =
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
  readonly type: SdkErrorType
  readonly code?: string
  readonly operation?: SdkOperation
  readonly appId?: bigint
  readonly txId?: string
  readonly cause?: unknown
  readonly details?: unknown

  /**
   * @param type The failure category.
   * @param message The original failure message.
   * @param options Optional code, operation context, cause, and raw details.
   */
  constructor(type: SdkErrorType, message: string, options: SdkErrorOptions = {}) {
    super(message)
    this.name = 'SdkError'
    this.type = type
    if (options.code !== undefined) this.code = options.code
    if (options.operation !== undefined) this.operation = options.operation
    if (options.appId !== undefined) this.appId = options.appId
    if (options.txId !== undefined) this.txId = options.txId
    if (options.cause !== undefined) this.cause = options.cause
    if (options.details !== undefined) this.details = options.details
  }
}

// Protocol and user failures are expected; network, deployment-mismatch, and unknown failures are not.
const EXPECTED_FAILURE_TYPES: ReadonlySet<SdkErrorType> = new Set(['validation', 'routing', 'not-found', 'chain-state', 'stale-proof'])

/**
 * Log a final failure at warn for expected rejections, error for unexpected ones, then throw it.
 *
 * @param error The classified failure.
 * @throws {SdkError} Always.
 */
export function throwSdkError(error: SdkError): never {
  const level = EXPECTED_FAILURE_TYPES.has(error.type) ? 'warn' : 'error'
  sdkLogger()[level]('operation.failed', {
    ...(error.operation === undefined ? {} : { operation: error.operation }),
    ...(error.appId === undefined ? {} : { appId: error.appId.toString() }),
    type: error.type,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.txId === undefined ? {} : { txId: error.txId }),
  })
  throw error
}

/**
 * Log and throw a validation failure.
 *
 * @param message The original failure message.
 * @param operation The operation that failed.
 * @param appId The application the operation targeted, when known.
 * @throws {SdkError} Always.
 */
export function validationError(message: string, operation: SdkOperation, appId?: bigint): never {
  throwSdkError(new SdkError('validation', message, { operation, ...(appId === undefined ? {} : { appId }) }))
}

/**
 * Log a confirmed write at info; skipped when the call sent nothing (no Registry, already registered).
 *
 * @param operation The write operation.
 * @param appId The application the write touched.
 * @param confirmation The confirmed write.
 */
export function logWriteConfirmed(operation: SdkOperation, appId: bigint, confirmation: WriteConfirmation): void {
  if (confirmation.txIds.length === 0) return
  sdkLogger().info('write.confirmed', {
    operation,
    appId: appId.toString(),
    txIds: confirmation.txIds,
    ...(confirmation.confirmedRound === undefined ? {} : { confirmedRound: confirmation.confirmedRound.toString() }),
    ...(confirmation.position === undefined ? {} : { position: confirmation.position }),
    ...(confirmation.amount === undefined ? {} : { amount: confirmation.amount.toString() }),
  })
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

// Types that drive a retry; every other contract assert is chain state.
const TYPE_BY_CODE: Readonly<Record<string, SdkErrorType>> = {
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
 * Infer the failure type from its text and code.
 *
 * @param text The failure text.
 * @param code The resolved assert code, if any.
 * @returns The failure category.
 */
function typeFor(text: string, code: string | undefined): SdkErrorType {
  if (NOT_FOUND_PATTERN.test(text)) return 'not-found'
  if (NETWORK_PATTERN.test(text)) return 'network'
  if (code === undefined) return 'unknown'
  return TYPE_BY_CODE[code] ?? 'chain-state'
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
  return new SdkError(typeFor(text, code), message, {
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
    throwSdkError(classifyChainError(error, { operation, ...(appId === undefined ? {} : { appId }) }))
  }
}

/**
 * Whether a submission failed on a stale Merkle proof (a concurrent pledge/refund moved the root).
 *
 * @param error The failure from a chain submission.
 * @returns True when rebuilding proofs and retrying once is correct.
 */
export function isStaleProofError(error: unknown): boolean {
  return classifyChainError(error).type === 'stale-proof'
}

/**
 * Whether a refund failed because the campaign path stopped being valid (vault box settled, or campaign deleted) between the box read and the send.
 *
 * @param error The failure from a chain submission.
 * @returns True when re-reading the vault box and rebuilding the refund once is correct.
 */
export function isCampaignRoutingError(error: unknown): boolean {
  const type = classifyChainError(error).type
  return type === 'routing' || type === 'not-found'
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
    clearTreeCache()
    return await run()
  }
  try {
    return await submit()
  } catch (error) {
    const classified = classifyChainError(error, { operation, appId })
    if (classified.type !== 'stale-proof') throw classified
    sdkLogger().debug('stale-proof.retry', { operation, appId: appId.toString() })
    try {
      return await submit()
    } catch (retryError) {
      throw classifyChainError(retryError, { operation, appId })
    }
  }
}
