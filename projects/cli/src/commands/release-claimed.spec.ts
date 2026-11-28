import type * as Sdk from '@kasakame/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../app/context.js'
import type { CliOptions } from '../app/options.js'
import { runReleaseClaimed } from './release-claimed.js'
import {
  VAULT_CLAIMED,
  VAULT_OPEN,
  WALLET,
  commandContext,
  commandContextWithoutAppId,
  vaultBox,
  type FakeContext,
} from './test-fixtures.js'

const sdkMocks = vi.hoisted(() => ({
  fetchVaultBox: vi.fn(),
  releaseClaimed: vi.fn(),
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
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_CLAIMED))
  sdkMocks.releaseClaimed.mockResolvedValue({ txIds: ['RELEASETX'], confirmedRound: 99n })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runReleaseClaimed', () => {
  it('releases a claimed campaign box in one session', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_CLAIMED, { paidOut: 2_000_000n }))

    expect(await runReleaseClaimed(ctx({ command: 'release-claimed' }))).toBe(0)

    expect(sdkMocks.releaseClaimed).toHaveBeenCalledWith(1n, WALLET)
    expect(console.error).toHaveBeenCalledWith('Submitting: release the vault box for claimed campaign 1…')
    expect(console.log).toHaveBeenCalledWith("Released the vault box for campaign 1; its minimum balance is back in the vault's account.")
    expect(lastContext.session).toHaveBeenCalled()
  })

  it('prints the plan in a dry run without submitting', async () => {
    expect(await runReleaseClaimed(ctx({ command: 'release-claimed', dryRun: true }))).toBe(0)

    expect(sdkMocks.releaseClaimed).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would release the vault box for claimed campaign 1.')
    expect(console.log).toHaveBeenCalledWith('Dry run: nothing submitted.')
    expect(lastContext.session).not.toHaveBeenCalled()
  })

  it('reports a missing box without opening the wallet', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(undefined)

    expect(await runReleaseClaimed(ctx({ command: 'release-claimed' }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith('Campaign 1 has no vault box; there is nothing to release.')
    expect(lastContext.session).not.toHaveBeenCalled()
  })

  it('rejects a box that is not claimed before opening the wallet', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_OPEN))

    await expect(runReleaseClaimed(ctx({ command: 'release-claimed' }))).rejects.toThrow(
      "Campaign 1 is not claimed; only a claimed campaign's vault box can be released",
    )
    expect(lastContext.session).not.toHaveBeenCalled()
  })

  it('propagates a failed release', async () => {
    sdkMocks.releaseClaimed.mockRejectedValue(new Error('rejected'))

    await expect(runReleaseClaimed(ctx({ command: 'release-claimed' }))).rejects.toThrow('rejected')
    expect(lastContext.session).toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(
      runReleaseClaimed(commandContextWithoutAppId({ command: 'release-claimed', network: 'testnet', signer: 'mnemonic', dryRun: false })),
    ).rejects.toThrow('release-claimed requires exactly one app id')
  })
})
