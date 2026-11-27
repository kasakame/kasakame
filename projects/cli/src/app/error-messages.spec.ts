import { SdkError } from '@kasakame/sdk'
import { describe, expect, it } from 'vitest'
import { cliErrorMessage } from './error-messages.js'
import type { CommandName } from './options.js'

describe('cliErrorMessage', () => {
  it('maps known SDK codes', () => {
    expect(cliErrorMessage(new SdkError('chain-state', 'x', { code: 'campaign-not-open' }), 'withdraw')).toBe(
      'The campaign is no longer open.',
    )
    expect(cliErrorMessage(new SdkError('chain-state', 'x', { code: 'goal-was-reached-no-refunds' }), 'refund')).toBe(
      'The campaign reached its goal; there is nothing to refund.',
    )
    expect(cliErrorMessage(new SdkError('chain-state', 'x', { code: 'refund-window-closed' }), 'refund')).toBe(
      'The refund window has closed.',
    )
    expect(cliErrorMessage(new SdkError('chain-state', 'x', { code: 'campaign-max-size' }), 'withdraw')).toBe(
      'The campaign is full and cannot accept more pledges.',
    )
    expect(cliErrorMessage(new SdkError('chain-state', 'x', { code: 'campaign-not-claimed' }), 'release-claimed')).toBe(
      'The campaign vault box is not claimed.',
    )
    expect(cliErrorMessage(new SdkError('chain-state', 'x', { code: 'campaign-balance-outstanding' }), 'release-claimed')).toBe(
      'The campaign balance is still outstanding.',
    )
    expect(cliErrorMessage(new SdkError('chain-state', 'x', { code: 'campaign-is-not-failed' }), 'finalize')).toBe(
      'The campaign is not settled as failed.',
    )
    expect(cliErrorMessage(new SdkError('chain-state', 'x', { code: 'campaign-vault-mismatch' }), 'settle-open')).toBe(
      'The campaign belongs to a different vault.',
    )
    expect(cliErrorMessage(new SdkError('chain-state', 'x', { code: 'unknown-campaign' }), 'finalize')).toBe(
      'The campaign has no vault box.',
    )
    expect(cliErrorMessage(new SdkError('chain-state', 'x', { code: 'only-the-creator-can-delete' }), 'delete')).toBe(
      'Only the campaign creator can do that.',
    )
    expect(cliErrorMessage(new SdkError('chain-state', 'x', { code: 'only-the-campaign-creator-can-register' }), 'claim')).toBe(
      'Only the campaign creator can do that.',
    )
    expect(cliErrorMessage(new SdkError('chain-state', 'x', { code: 'some-other-code' }), 'claim')).toBe(
      'Could not claim the campaign. Please try again.',
    )
  })

  it('maps SDK kinds', () => {
    expect(cliErrorMessage(new SdkError('stale-proof', 'logic eval error'), 'refund')).toBe(
      'Another pledge or refund landed first. Retry the command.',
    )
    expect(cliErrorMessage(new SdkError('not-found', 'application 1 not found'), 'claim', 1n)).toBe(
      'Campaign 1 was not found. It may have been deleted.',
    )
    expect(cliErrorMessage(new SdkError('not-found', 'application 1 not found'), 'claim')).toBe(
      'The campaign was not found. It may have been deleted.',
    )
    expect(cliErrorMessage(new SdkError('network', 'fetch failed'), 'refund')).toBe(
      'Could not reach the chain. Check your connection and try again.',
    )
    expect(cliErrorMessage(new SdkError('routing', 'campaign is not open'), 'refund')).toBe(
      'This action is no longer available. Retry the command.',
    )
    expect(cliErrorMessage(new SdkError('registry-mismatch', 'hash mismatch'), 'claim')).toBe(
      'This CLI does not match the campaign registry. Update kasakame and retry.',
    )
    expect(cliErrorMessage(new SdkError('validation', 'goal too large'), 'claim')).toBe('goal too large')
  })

  it('falls back per command for unknown and chain-state failures', () => {
    const expected: Record<CommandName, string> = {
      refund: 'Could not refund the pledges. Please try again.',
      withdraw: 'Could not withdraw the pledges. Please try again.',
      claim: 'Could not claim the campaign. Please try again.',
      delete: 'Could not delete the campaign. Please try again.',
      'settle-open': 'Could not settle the campaign. Please try again.',
      finalize: 'Could not finalize the campaign. Please try again.',
      'release-claimed': 'Could not release the campaign vault box. Please try again.',
      pledges: 'Could not read pledges from the indexer. Check your connection and try again.',
      campaigns: 'Could not read campaigns from the indexer. Check your connection and try again.',
      login: 'Could not connect the wallet. Please try again.',
      whoami: 'Could not read the wallet session. Please try again.',
      logout: 'Could not disconnect the wallet. Please try again.',
    }
    for (const [command, message] of Object.entries(expected)) {
      expect(cliErrorMessage(new SdkError('unknown', 'logic eval error'), command as CommandName)).toBe(message)
      expect(cliErrorMessage(new SdkError('chain-state', 'some assert'), command as CommandName)).toBe(message)
    }
    expect(cliErrorMessage(new SdkError('unknown', 'boom'))).toBe('Command failed. Please try again.')
  })

  it('keeps CLI errors but hides chain traces', () => {
    expect(cliErrorMessage(new Error('--vault is required on localnet'), 'refund')).toBe('--vault is required on localnet')
    expect(cliErrorMessage(new Error('transaction ABC: logic eval error: unexpected assert. Details: pc=12'), 'refund')).toBe(
      'Could not refund the pledges. Please try again.',
    )
    expect(cliErrorMessage(undefined, 'claim')).toBe('Could not claim the campaign. Please try again.')
  })

  it('maps wallet rejections and dead sessions', () => {
    expect(cliErrorMessage(new Error('Transaction rejected by user'), 'refund')).toBe('Transaction rejected in the wallet.')
    expect(cliErrorMessage(new Error('PeraWalletConnect was not initialized correctly.'), 'refund')).toBe(
      'Wallet session expired. Run `kasakame login` again.',
    )
  })
})
