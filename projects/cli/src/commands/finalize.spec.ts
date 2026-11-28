import type * as Sdk from '@kasakame/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../app/context.js'
import type { CliOptions } from '../app/options.js'
import { runFinalize } from './finalize.js'
import {
  VAULT_CLAIMED,
  VAULT_FAILED,
  WALLET,
  commandContext,
  commandContextWithoutAppId,
  vaultBox,
  type FakeContext,
} from './test-fixtures.js'

const sdkMocks = vi.hoisted(() => ({
  fetchVaultBox: vi.fn(),
  fetchVaultConfig: vi.fn(),
  fetchChainTimestamp: vi.fn(),
  finalize: vi.fn(),
}))

let lastContext: FakeContext

function ctx(overrides: Partial<CliOptions> = {}): CommandContext {
  lastContext = commandContext(overrides)
  return lastContext
}

vi.mock('@kasakame/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof Sdk>()
  return {
    ...sdkMocks,
    SdkError: actual.SdkError,
    classifyChainError: actual.classifyChainError,
    refundWindowEndsAt: actual.refundWindowEndsAt,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_FAILED, { paidOut: 1_000_000n }))
  sdkMocks.fetchVaultConfig.mockResolvedValue({ window: 100n, sweepTarget: 'SWEEP' })
  sdkMocks.fetchChainTimestamp.mockResolvedValue(2_000n)
  sdkMocks.finalize.mockResolvedValue({ txIds: ['FINALIZETX'], confirmedRound: 99n })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runFinalize', () => {
  it('sweeps the residual after the refund window in one session', async () => {
    expect(await runFinalize(ctx({ command: 'finalize' }))).toBe(0)

    expect(sdkMocks.finalize).toHaveBeenCalledWith(1n, WALLET)
    expect(console.error).toHaveBeenCalledWith('Submitting: finalize campaign 1…')
    expect(console.log).toHaveBeenCalledWith("Swept 1 ALGO to the vault's sweep target and released the vault box for campaign 1.")
    expect(lastContext.session).toHaveBeenCalled()
  })

  it('finalizes a fully paid-out box without reading the refund window', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_FAILED, { paidOut: 2_000_000n }))

    expect(await runFinalize(ctx({ command: 'finalize' }))).toBe(0)

    expect(sdkMocks.fetchVaultConfig).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Released the vault box for campaign 1; there was nothing left to sweep.')
  })

  it('prints the plan in a dry run without submitting', async () => {
    expect(await runFinalize(ctx({ command: 'finalize', dryRun: true }))).toBe(0)

    expect(sdkMocks.finalize).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith("Would finalize campaign 1 and sweep 1 ALGO to the vault's sweep target.")
    expect(console.log).toHaveBeenCalledWith('Dry run: nothing submitted.')
    expect(lastContext.session).not.toHaveBeenCalled()
  })

  it('prints the release plan for a fully paid-out box in a dry run', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_FAILED, { paidOut: 2_000_000n }))

    expect(await runFinalize(ctx({ command: 'finalize', dryRun: true }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith('Would finalize campaign 1 and release its vault box.')
  })

  it('rejects while the refund window is still open', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_FAILED, { paidOut: 1_000_000n, settledAt: 1_950n }))

    await expect(runFinalize(ctx({ command: 'finalize' }))).rejects.toThrow(
      'The refund window for campaign 1 is open until 1970-01-01 00:34 UTC; backers can still refund',
    )
    expect(lastContext.session).not.toHaveBeenCalled()
  })

  it('rejects a campaign without a vault box', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(undefined)

    await expect(runFinalize(ctx({ command: 'finalize' }))).rejects.toThrow(
      'Campaign 1 has no vault box; it was already finalized or never funded',
    )
    expect(lastContext.session).not.toHaveBeenCalled()
  })

  it('rejects a box that is not failed', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_CLAIMED))

    await expect(runFinalize(ctx({ command: 'finalize' }))).rejects.toThrow(
      'Campaign 1 is not settled as failed; there is nothing to finalize',
    )
    expect(lastContext.session).not.toHaveBeenCalled()
  })

  it('propagates a failed finalization', async () => {
    sdkMocks.finalize.mockRejectedValue(new Error('rejected'))

    await expect(runFinalize(ctx({ command: 'finalize' }))).rejects.toThrow('rejected')
    expect(lastContext.session).toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(
      runFinalize(commandContextWithoutAppId({ command: 'finalize', network: 'testnet', signer: 'mnemonic', dryRun: false })),
    ).rejects.toThrow('finalize requires exactly one app id')
  })
})
