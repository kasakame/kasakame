import { SdkError } from '@kasakame/sdk'
import { describe, expect, it } from 'vitest'
import { classifyError, errorMessage, isDismissalError, isSessionError } from './errors'

describe('classifyError', () => {
  it('detects dead wallet sessions', () => {
    expect(classifyError(new Error('PeraWalletConnect was not initialized correctly.'))).toBe('session')
    expect(classifyError(new Error('Wallet session expired'))).toBe('session')
    expect(classifyError(new Error('no session found'))).toBe('session')
    expect(classifyError(new Error('No signer found for address SOMEADDRESS'))).toBe('session')
  })

  it('detects user rejections first', () => {
    expect(classifyError(new Error('Transaction rejected by user'))).toBe('rejected')
    expect(classifyError(new Error('Sign denied'))).toBe('rejected')
    expect(classifyError(new Error('cancelled previous request'))).toBe('rejected')
  })

  it('maps chain failures through the SDK classifications', () => {
    expect(classifyError(new Error('campaign is not open'))).toBe('routing')
    expect(classifyError(new SdkError('stale-proof', 'stale or forged frontier'))).toBe('stale-proof')
    expect(classifyError(new SdkError('network', 'fetch failed'))).toBe('network')
    expect(classifyError(new SdkError('registry-mismatch', 'hash mismatch'))).toBe('registry-mismatch')
  })

  it('falls back to unknown', () => {
    expect(classifyError(new Error('boom'))).toBe('unknown')
    expect(classifyError('boom')).toBe('unknown')
    expect(classifyError(undefined)).toBe('unknown')
  })
})

describe('error predicates', () => {
  it('isDismissalError matches closed wallet popups only', () => {
    expect(isDismissalError(new Error('Connect modal is closed by user'))).toBe(true)
    expect(isDismissalError(new Error('Connect is cancelled by user'))).toBe(true)
    expect(isDismissalError(new Error('modal_closed'))).toBe(true)
    expect(isDismissalError(new Error('Exodus is not available.'))).toBe(false)
    expect(isDismissalError(new Error('no extension'))).toBe(false)
    expect(isDismissalError(undefined)).toBe(false)
  })

  it('isSessionError matches sessions only', () => {
    expect(isSessionError(new Error('Wallet session expired'))).toBe(true)
    expect(isSessionError(new Error('boom'))).toBe(false)
  })
})

describe('errorMessage', () => {
  it('reports rejections plainly for every action', () => {
    const rejection = new Error('Transaction rejected by user')
    expect(errorMessage(rejection, 'pledge')).toBe('Transaction rejected in your wallet.')
    expect(errorMessage(rejection, 'create')).toBe('Transaction rejected in your wallet.')
    expect(errorMessage(rejection, 'transaction')).toBe('Transaction rejected in your wallet.')
  })

  it('maps known codes to user copy', () => {
    expect(errorMessage(new SdkError('chain-state', 'x', { code: 'campaign-not-open' }), 'pledge')).toBe('This campaign is no longer open.')
    expect(errorMessage(new SdkError('chain-state', 'x', { code: 'pledging-closed' }), 'transaction')).toBe(
      'Pledging is closed for this campaign.',
    )
    expect(errorMessage(new SdkError('chain-state', 'x', { code: 'goal-was-reached-no-refunds' }), 'transaction')).toBe(
      'The campaign reached its goal; there is nothing to refund.',
    )
    expect(errorMessage(new SdkError('chain-state', 'x', { code: 'deadline-not-passed' }), 'transaction')).toBe(
      'The deadline has not passed yet.',
    )
    expect(errorMessage(new SdkError('chain-state', 'x', { code: 'refund-window-closed' }), 'transaction')).toBe(
      'The refund window has closed.',
    )
    expect(errorMessage(new SdkError('chain-state', 'x', { code: 'only-the-creator-can-claim' }), 'transaction')).toBe(
      'Only the campaign creator can do that.',
    )
    expect(errorMessage(new SdkError('chain-state', 'x', { code: 'campaign-max-size' }), 'pledge')).toBe(
      "This campaign has reached its maximum size and can't accept new pledges.",
    )
    expect(errorMessage(new SdkError('chain-state', 'x', { code: 'campaign-not-registered' }), 'create')).toBe(
      'This campaign is not registered with the official registry.',
    )
    expect(errorMessage(new SdkError('chain-state', 'x', { code: 'some-other-code' }), 'transaction')).toBe(
      'Transaction failed. Another pledge or refund may have landed first - please try again.',
    )
  })

  it('maps SDK kinds without showing the raw chain message', () => {
    const stale = new SdkError('stale-proof', 'transaction ABC: logic eval error: proof does not match root. Details: pc=1')
    expect(errorMessage(stale, 'pledge')).toBe('Another pledge or refund landed first. Please try again.')
    expect(errorMessage(stale, 'pledge')).not.toContain('logic eval')
    expect(errorMessage(new SdkError('not-found', 'application 1 not found'), 'transaction')).toBe(
      'This campaign could not be found. It may have been deleted.',
    )
    expect(errorMessage(new SdkError('network', 'fetch failed'), 'transaction')).toBe(
      'Could not reach the chain. Check your connection and try again.',
    )
    expect(errorMessage(new SdkError('routing', 'campaign is not open'), 'transaction')).toBe(
      'This action is no longer available. Refresh and try again.',
    )
    expect(errorMessage(new SdkError('registry-mismatch', 'hash mismatch'), 'create')).toBe(
      'This app is out of date with the campaign registry. Refresh and try again.',
    )
  })

  it('maps failures per action and falls back for unknown kinds', () => {
    expect(errorMessage(new Error('boom'), 'pledge')).toBe('Failed to pledge. Please try again.')
    expect(errorMessage(new Error('boom'), 'create')).toBe('Failed to create campaign. Please try again.')
    expect(errorMessage(new Error('boom'), 'transaction')).toBe(
      'Transaction failed. Another pledge or refund may have landed first - please try again.',
    )
    expect(errorMessage(new SdkError('validation', 'goal too large'), 'create')).toBe('Failed to create campaign. Please try again.')
    expect(errorMessage(new SdkError('chain-state', 'some assert'), 'transaction')).toBe(
      'Transaction failed. Another pledge or refund may have landed first - please try again.',
    )
  })
})
