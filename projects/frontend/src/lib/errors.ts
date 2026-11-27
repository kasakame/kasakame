/**
 * Error taxonomy: wallet failures are matched from vendor messages, chain failures come from the SDK's classified kind/code.
 */

import { classifyChainError, type SdkErrorType } from '@kasakame/sdk'

export type ErrorKind = 'session' | 'rejected' | SdkErrorType

export type FailedAction = 'pledge' | 'create' | 'transaction'

const SESSION_PATTERN = /not initialized correctly|session expired|no session|has disconnected|disconnected|no signer found/i
const REJECTION_PATTERN = /\breject|\bdenied|dismissed|cancelled by user|\bcancelled\b/i
// Connect-flow dismissals (verified against the vendor bundles): closing the wallet popup rejects `connect()` with one of these.
const DISMISSAL_PATTERN = /closed by user|cancelled by user|modal_closed/i

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  'campaign-not-open': 'This campaign is no longer open.',
  'campaign-not-refundable': 'This campaign is not refundable.',
  'pledging-closed': 'Pledging is closed for this campaign.',
  'goal-not-reached': 'The campaign has not reached its goal.',
  'goal-was-reached': 'The campaign reached its goal.',
  'goal-was-reached-no-refunds': 'The campaign reached its goal; there is nothing to refund.',
  'deadline-not-passed': 'The deadline has not passed yet.',
  'refund-window-closed': 'The refund window has closed.',
  'refund-window-open': 'The refund window is still open.',
  'campaign-max-size': "This campaign has reached its maximum size and can't accept new pledges.",
  'cancel-final-day-goal': 'This withdrawal would drop the campaign below its goal in the final day.',
  'campaign-already-registered': 'This campaign is already registered.',
  'campaign-not-registered': 'This campaign is not registered with the official registry.',
  'not-an-official-kasakame-campaign': 'This campaign is not registered with the official registry.',
  'campaign-is-still-live': 'The campaign is still live.',
  'already-claimed': 'This campaign has already been claimed.',
}

/**
 * Classify a failure from a wallet signing call or chain submission.
 *
 * @param error The caught failure.
 * @returns The category driving retry, messaging, and recovery decisions.
 */
export function classifyError(error: unknown): ErrorKind {
  if (!(error instanceof Error)) return 'unknown'
  if (REJECTION_PATTERN.test(error.message)) return 'rejected'
  if (SESSION_PATTERN.test(error.message)) return 'session'
  return classifyChainError(error).type
}

/**
 * Whether a signing failure means the wallet session is dead (resumed state with no live bridge); the fix is always disconnect and reconnect.
 *
 * @param error The failure from a wallet signing call.
 * @returns True when the user should reconnect instead of retrying.
 */
export function isSessionError(error: unknown): boolean {
  return classifyError(error) === 'session'
}

/**
 * Whether a connect-flow failure is just the user closing the wallet popup, which callers treat as a quiet no-op.
 *
 * @param error The failure from a wallet `connect()` call.
 * @returns True when no error message should be shown.
 */
export function isDismissalError(error: unknown): boolean {
  return error instanceof Error && DISMISSAL_PATTERN.test(error.message)
}

/**
 * User-facing message for a failed action; raw chain messages stay out of the UI. Session failures are handled separately (they need recovery, not words).
 *
 * @param error The caught failure.
 * @param action The action that failed.
 * @returns Message text for the UI.
 */
export function errorMessage(error: unknown, action: FailedAction): string {
  if (classifyError(error) === 'rejected') return 'Transaction rejected in your wallet.'
  const classified = classifyChainError(error)
  if (classified.code !== undefined) {
    const codeMessage = CODE_MESSAGES[classified.code]
    if (codeMessage !== undefined) return codeMessage
    if (classified.code.startsWith('only-the-creator') || classified.code.startsWith('only-the-campaign-creator')) {
      return 'Only the campaign creator can do that.'
    }
  }
  switch (classified.type) {
    case 'stale-proof':
      return 'Another pledge or refund landed first. Please try again.'
    case 'not-found':
      return 'This campaign could not be found. It may have been deleted.'
    case 'network':
      return 'Could not reach the chain. Check your connection and try again.'
    case 'routing':
      return 'This action is no longer available. Refresh and try again.'
    case 'registry-mismatch':
      return 'This app is out of date with the campaign registry. Refresh and try again.'
    case 'validation':
    case 'chain-state':
    case 'unknown':
      return actionMessage(action)
  }
}

function actionMessage(action: FailedAction): string {
  switch (action) {
    case 'pledge':
      return 'Failed to pledge. Please try again.'
    case 'create':
      return 'Failed to create campaign. Please try again.'
    case 'transaction':
      return 'Transaction failed. Another pledge or refund may have landed first - please try again.'
  }
}
