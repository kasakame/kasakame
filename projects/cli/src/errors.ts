import { classifyChainError, SdkError } from '@kasakame/sdk'
import type { CommandName } from './args.js'

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  'campaign-not-open': 'The campaign is no longer open.',
  'campaign-not-refundable': 'The campaign is not refundable.',
  'pledging-closed': 'Pledging is closed for the campaign.',
  'goal-not-reached': 'The campaign has not reached its goal.',
  'goal-was-reached': 'The campaign reached its goal; there is nothing to refund.',
  'goal-was-reached-no-refunds': 'The campaign reached its goal; there is nothing to refund.',
  'deadline-not-passed': 'The deadline has not passed yet.',
  'refund-window-closed': 'The refund window has closed.',
  'refund-window-open': 'The refund window is still open.',
  'campaign-max-size': 'The campaign is full and cannot accept more pledges.',
  'cancel-final-day-goal': 'That withdrawal would drop the campaign below its goal in the final day.',
  'campaign-already-registered': 'The campaign is already registered.',
  'campaign-not-registered': 'The campaign is not registered with the official registry.',
  'not-an-official-kasakame-campaign': 'The campaign is not registered with the official registry.',
  'campaign-is-still-live': 'The campaign is still live.',
  'already-claimed': 'The campaign has already been claimed.',
  'insufficient-campaign-balance': 'The campaign balance is too low for that action.',
}

const CHAIN_DETAIL_PATTERN = /logic eval error|TransactionPool|ApprovalProgram|pc=|trace/i
const WALLET_REJECTION_PATTERN = /\breject|\bdenied|dismissed|cancelled by user|\bcancelled\b/i
const SESSION_PATTERN = /not initialized correctly|session expired|no session|has disconnected|disconnected|no signer found/i

/**
 * User-facing CLI message for a failure; raw chain traces stay out of normal output.
 *
 * @param error The caught failure.
 * @param command The command that failed, when parsed.
 * @param appId The campaign id, when known.
 * @returns A short message for stderr.
 */
export function cliErrorMessage(error: unknown, command?: CommandName, appId?: bigint): string {
  if (error instanceof SdkError) return sdkMessage(error, command, appId)
  if (!(error instanceof Error)) return fallback(command)
  if (WALLET_REJECTION_PATTERN.test(error.message)) return 'Transaction rejected in the wallet.'
  if (SESSION_PATTERN.test(error.message)) return 'Wallet session expired. Run `kasakame login` again.'
  if (!CHAIN_DETAIL_PATTERN.test(error.message)) return error.message
  return sdkMessage(classifyChainError(error), command, appId)
}

function sdkMessage(error: SdkError, command: CommandName | undefined, appId: bigint | undefined): string {
  if (error.code !== undefined) {
    const codeMessage = CODE_MESSAGES[error.code]
    if (codeMessage !== undefined) return codeMessage
    if (error.code.startsWith('only-the-creator') || error.code.startsWith('only-the-campaign-creator')) {
      return 'Only the campaign creator can do that.'
    }
  }
  switch (error.type) {
    case 'stale-proof':
      return 'Another pledge or refund landed first. Retry the command.'
    case 'not-found':
      return appId === undefined
        ? 'The campaign was not found. It may have been deleted.'
        : `Campaign ${appId.toString()} was not found. It may have been deleted.`
    case 'network':
      return 'Could not reach the chain. Check your connection and try again.'
    case 'routing':
      return 'This action is no longer available. Retry the command.'
    case 'registry-mismatch':
      return 'This CLI does not match the campaign registry. Update kasakame and retry.'
    case 'validation':
      return error.message
    case 'chain-state':
    case 'unknown':
      return fallback(command)
  }
}

function fallback(command: CommandName | undefined): string {
  switch (command) {
    case 'refund':
      return 'Could not refund the pledges. Please try again.'
    case 'withdraw':
      return 'Could not withdraw the pledges. Please try again.'
    case 'claim':
      return 'Could not claim the campaign. Please try again.'
    case 'delete':
      return 'Could not delete the campaign. Please try again.'
    case 'pledges':
      return 'Could not read pledges from the indexer. Check your connection and try again.'
    case 'campaigns':
      return 'Could not read campaigns from the indexer. Check your connection and try again.'
    case 'login':
      return 'Could not connect the wallet. Please try again.'
    case 'whoami':
      return 'Could not read the wallet session. Please try again.'
    case 'logout':
      return 'Could not disconnect the wallet. Please try again.'
    default:
      return 'Command failed. Please try again.'
  }
}
