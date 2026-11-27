import type * as Sdk from '@kasakame/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliOptions } from './args.js'
import {
  runCampaigns,
  runClaim,
  runDelete,
  runFinalize,
  runPledges,
  runRefund,
  runReleaseClaimed,
  runSettleOpen,
  runWithdraw,
} from './commands/index.js'

const sdkMocks = vi.hoisted(() => ({
  enumerateCampaigns: vi.fn(),
  fetchCampaignHeader: vi.fn(),
  fetchChainTimestamp: vi.fn(),
  getCampaignStatus: vi.fn(),
  fetchMyLeaves: vi.fn(),
  fetchVaultBox: vi.fn(),
  fetchVaultConfig: vi.fn(),
  cancelPledge: vi.fn(),
  claim: vi.fn(),
  deleteCampaign: vi.fn(),
  refund: vi.fn(),
  settleOpen: vi.fn(),
  releaseClaimed: vi.fn(),
  finalize: vi.fn(),
}))
const closeMock = vi.hoisted(() => vi.fn(async () => {}))
const openCliSessionMock = vi.hoisted(() => vi.fn())
const whoamiMock = vi.hoisted(() => vi.fn())
const mnemonicSessionMock = vi.hoisted(() => vi.fn())

vi.mock('@kasakame/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof Sdk>()
  return {
    ...sdkMocks,
    SdkError: actual.SdkError,
    classifyChainError: actual.classifyChainError,
    refundWindowEndsAt: actual.refundWindowEndsAt,
  }
})
vi.mock('./session.js', () => ({ openCliSession: openCliSessionMock }))
vi.mock('./walletconnect.js', () => ({ whoami: whoamiMock }))
vi.mock('./mnemonic.js', () => ({ mnemonicSession: mnemonicSessionMock }))

const WALLET = { address: 'BACKER', signer: vi.fn() }
const VALID_ADDRESS = '4JBYQTVKROJEKG6IZWFAOGGAM2KH65E7JUSC3S5C4EPYOCWGZJOYIRKGRI'
const HEADER = {
  id: 1n,
  creator: 'CREATOR',
  title: 'Title',
  metadataUri: 'ipfs://metadata',
  goalMicroAlgos: 10_000_000n,
  deadlineSeconds: 1_000n,
  raisedMicroAlgos: 2_000_000n,
  status: 'open' as const,
  deleted: false,
}

function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    command: 'refund',
    appId: 1n,
    network: 'testnet',
    signer: 'mnemonic',
    dryRun: false,
    ...overrides,
  }
}

function leaf(position: number, amount: bigint) {
  return { position, amount, txidHex: 'aa' }
}

const VAULT_OPEN = 1
const VAULT_FAILED = 2
const VAULT_CLAIMED = 3

function vaultBox(status: number, overrides: Partial<Sdk.VaultBoxView> = {}): Sdk.VaultBoxView {
  return { paidIn: 2_000_000n, paidOut: 0n, status, settledAt: 1_000n, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  sdkMocks.fetchCampaignHeader.mockResolvedValue(HEADER)
  sdkMocks.fetchChainTimestamp.mockResolvedValue(2_000n)
  sdkMocks.getCampaignStatus.mockReturnValue('failed')
  sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_500_000n), leaf(1, 1n)])
  sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_OPEN))
  sdkMocks.fetchVaultConfig.mockResolvedValue({ window: 100n, sweepTarget: 'SWEEP' })
  sdkMocks.cancelPledge.mockResolvedValue({ txIds: ['CANCELTX'], confirmedRound: 99n })
  sdkMocks.claim.mockResolvedValue({ txIds: ['CLAIMTX'], confirmedRound: 99n })
  sdkMocks.deleteCampaign.mockResolvedValue({ txIds: ['DELETETX'], confirmedRound: 99n })
  sdkMocks.refund.mockResolvedValue({ txIds: ['REFUNDTX'], confirmedRound: 99n })
  sdkMocks.settleOpen.mockResolvedValue({ txIds: ['SETTLETX'], confirmedRound: 99n })
  sdkMocks.releaseClaimed.mockResolvedValue({ txIds: ['RELEASETX'], confirmedRound: 99n })
  sdkMocks.finalize.mockResolvedValue({ txIds: ['FINALIZETX'], confirmedRound: 99n })
  mnemonicSessionMock.mockResolvedValue(WALLET)
  openCliSessionMock.mockResolvedValue({ wallet: WALLET, close: closeMock })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runRefund', () => {
  it('refunds every live pledge and closes the session', async () => {
    expect(await runRefund(options({ all: true }))).toBe(0)

    expect(sdkMocks.fetchCampaignHeader).toHaveBeenCalledWith(1n)
    expect(sdkMocks.getCampaignStatus).toHaveBeenCalledWith(HEADER, 2_000n)
    expect(sdkMocks.fetchMyLeaves).toHaveBeenCalledWith(1n, 'BACKER')
    expect(sdkMocks.refund).toHaveBeenCalledTimes(2)
    expect(sdkMocks.refund).toHaveBeenNthCalledWith(1, 1n, WALLET, leaf(0, 1_500_000n))
    expect(sdkMocks.refund).toHaveBeenNthCalledWith(2, 1n, WALLET, leaf(1, 1n))
    expect(console.log).toHaveBeenCalledWith('Refunded pledge #0 (1.5 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Refunded pledge #1 (0.000001 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Refunded 2 pledges.')
    expect(console.error).toHaveBeenCalledWith('2 pledges selected; each is a separate transaction.')
    expect(console.error).toHaveBeenCalledWith('Submitting: refund pledge #0 (1.5 ALGO)…')
    expect(closeMock).toHaveBeenCalled()
  })

  it('announces the wallet approval for the wallet signer', async () => {
    expect(await runRefund(options({ signer: 'wallet', all: true }))).toBe(0)
    expect(console.error).toHaveBeenCalledWith('2 pledges selected; your wallet asks for approval on each one.')
    expect(console.error).toHaveBeenCalledWith('Waiting for wallet approval: refund pledge #0 (1.5 ALGO)…')
  })

  it('refunds one selected pledge', async () => {
    expect(await runRefund(options({ pledge: 1 }))).toBe(0)

    expect(sdkMocks.refund).toHaveBeenCalledTimes(1)
    expect(sdkMocks.refund).toHaveBeenCalledWith(1n, WALLET, leaf(1, 1n))
    expect(console.log).toHaveBeenCalledWith('Refunded pledge #1 (0.000001 ALGO).')
  })

  it('prints planned refunds in a dry run without submitting', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_000_000n)])

    expect(await runRefund(options({ dryRun: true }))).toBe(0)

    expect(sdkMocks.refund).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would refund pledge #0 (1 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Dry run: 1 pledge would be refunded.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('keeps going after a failed pledge and exits non-zero', async () => {
    sdkMocks.refund.mockRejectedValueOnce(new Error('rejected')).mockResolvedValueOnce({ txIds: ['REFUNDTX'], confirmedRound: 99n })

    expect(await runRefund(options({ all: true }))).toBe(1)

    expect(sdkMocks.refund).toHaveBeenCalledTimes(2)
    expect(console.error).toHaveBeenCalledWith('Pledge #0 failed: Transaction rejected in the wallet.')
    expect(console.error).toHaveBeenCalledWith('Refunded 1 of 2 pledges; 1 failed.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('reports a non-Error failure', async () => {
    sdkMocks.refund.mockRejectedValue('rejected')

    expect(await runRefund(options({ all: true }))).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Pledge #0 failed: Could not refund the pledges. Please try again.')
  })

  it('prints the raw failure only at debug level', async () => {
    sdkMocks.refund.mockRejectedValue(new Error('Transaction rejected by user'))

    expect(await runRefund(options({ all: true, logLevel: 'debug' }))).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Pledge #0 failed: Transaction rejected in the wallet.')
    expect(console.error).toHaveBeenCalledWith('[detail] Transaction rejected by user')
  })

  it('does not print a detail for a non-Error at debug level', async () => {
    sdkMocks.refund.mockRejectedValue('rejected')

    expect(await runRefund(options({ all: true, logLevel: 'debug' }))).toBe(1)
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('[detail]'))
  })

  it('reports no live pledges', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([])

    expect(await runRefund(options())).toBe(0)

    expect(sdkMocks.refund).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('No live pledges to refund from campaign 1.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('closes the session when fetching leaves fails', async () => {
    sdkMocks.fetchMyLeaves.mockRejectedValue(new Error('indexer down'))

    await expect(runRefund(options())).rejects.toThrow('indexer down')
    expect(closeMock).toHaveBeenCalled()
  })

  it('rejects an open campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')

    await expect(runRefund(options())).rejects.toThrow('Campaign 1 is still open; use `kasakame withdraw` before the deadline')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a successful campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')

    await expect(runRefund(options())).rejects.toThrow('Campaign 1 succeeded; there is nothing to refund')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects an unknown campaign', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue(undefined)

    await expect(runRefund(options())).rejects.toThrow('Campaign 1 not found')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('turns a missing campaign into a clear error', async () => {
    sdkMocks.fetchCampaignHeader.mockRejectedValue(
      new Error('Network request error. Received status 404 (Not Found): no application found for application-id: 999999999'),
    )

    await expect(runRefund(options())).rejects.toThrow('Campaign 1 not found on testnet')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('treats a non-Error 404 as not found', async () => {
    sdkMocks.fetchCampaignHeader.mockRejectedValue('404')

    await expect(runRefund(options())).rejects.toThrow('Campaign 1 not found on testnet')
  })

  it('keeps unexpected indexer errors', async () => {
    sdkMocks.fetchCampaignHeader.mockRejectedValue(new Error('indexer down'))

    await expect(runRefund(options())).rejects.toThrow('indexer down')
  })

  it('requires an app id', async () => {
    await expect(runRefund({ command: 'refund', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'refund requires exactly one app id',
    )
  })
})

describe('runWithdraw', () => {
  function withdrawOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return options({ command: 'withdraw', ...overrides })
  }

  beforeEach(() => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')
  })

  it('withdraws every live pledge with --all and closes the session', async () => {
    expect(await runWithdraw(withdrawOptions({ all: true }))).toBe(0)

    expect(sdkMocks.fetchMyLeaves).toHaveBeenCalledWith(1n, 'BACKER')
    expect(sdkMocks.cancelPledge).toHaveBeenCalledTimes(2)
    expect(sdkMocks.cancelPledge).toHaveBeenNthCalledWith(1, 1n, WALLET, leaf(0, 1_500_000n))
    expect(sdkMocks.cancelPledge).toHaveBeenNthCalledWith(2, 1n, WALLET, leaf(1, 1n))
    expect(console.log).toHaveBeenCalledWith('Withdrawn pledge #0 (1.5 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Withdrawn pledge #1 (0.000001 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Withdrawn 2 pledges.')
    expect(console.error).toHaveBeenCalledWith('2 pledges selected; each is a separate transaction.')
    expect(console.error).toHaveBeenCalledWith('Submitting: withdraw pledge #0 (1.5 ALGO)…')
    expect(closeMock).toHaveBeenCalled()
  })

  it('withdraws one selected pledge with --pledge', async () => {
    expect(await runWithdraw(withdrawOptions({ pledge: 1 }))).toBe(0)

    expect(sdkMocks.cancelPledge).toHaveBeenCalledTimes(1)
    expect(sdkMocks.cancelPledge).toHaveBeenCalledWith(1n, WALLET, leaf(1, 1n))
    expect(console.log).toHaveBeenCalledWith('Withdrawn pledge #1 (0.000001 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Withdrawn 1 pledge.')
  })

  it('withdraws a single pledge without a flag', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_500_000n)])

    expect(await runWithdraw(withdrawOptions())).toBe(0)
    expect(sdkMocks.cancelPledge).toHaveBeenCalledTimes(1)
  })

  it('requires a selection when several pledges are live', async () => {
    await expect(runWithdraw(withdrawOptions())).rejects.toThrow('You have 2 live pledges in campaign 1; pass --pledge <position> or --all')
    expect(sdkMocks.cancelPledge).not.toHaveBeenCalled()
  })

  it('rejects an unknown leaf', async () => {
    await expect(runWithdraw(withdrawOptions({ pledge: 9 }))).rejects.toThrow('No live pledge #9 in campaign 1')
    expect(sdkMocks.cancelPledge).not.toHaveBeenCalled()
  })

  it('prints planned withdrawals in a dry run without submitting', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_000_000n)])

    expect(await runWithdraw(withdrawOptions({ dryRun: true }))).toBe(0)

    expect(sdkMocks.cancelPledge).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would withdraw pledge #0 (1 ALGO).')
    expect(console.log).toHaveBeenCalledWith('Dry run: 1 pledge would be withdrawn.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('keeps going after a failed withdrawal and exits non-zero', async () => {
    sdkMocks.cancelPledge.mockRejectedValueOnce(new Error('rejected')).mockResolvedValueOnce({ txIds: ['CANCELTX'], confirmedRound: 99n })

    expect(await runWithdraw(withdrawOptions({ all: true }))).toBe(1)

    expect(sdkMocks.cancelPledge).toHaveBeenCalledTimes(2)
    expect(console.error).toHaveBeenCalledWith('Pledge #0 failed: Transaction rejected in the wallet.')
    expect(console.error).toHaveBeenCalledWith('Withdrawn 1 of 2 pledges; 1 failed.')
  })

  it('reports no live pledges', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([])

    expect(await runWithdraw(withdrawOptions())).toBe(0)

    expect(sdkMocks.cancelPledge).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('No live pledges to withdraw from campaign 1.')
  })

  it('rejects a failed campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')

    await expect(runWithdraw(withdrawOptions())).rejects.toThrow('Campaign 1 already failed; use `kasakame refund` instead')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a successful campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')

    await expect(runWithdraw(withdrawOptions())).rejects.toThrow('Campaign 1 succeeded; its pledges can no longer be withdrawn')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(runWithdraw({ command: 'withdraw', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'withdraw requires exactly one app id',
    )
  })
})

describe('runClaim', () => {
  function claimOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return options({ command: 'claim', ...overrides })
  }

  beforeEach(() => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 10_000_000n })
  })

  it('claims a successful campaign for its creator and closes the session', async () => {
    expect(await runClaim(claimOptions())).toBe(0)

    expect(sdkMocks.claim).toHaveBeenCalledWith(1n, WALLET)
    expect(console.log).toHaveBeenCalledWith('Claimed campaign 1; the vault paid its live total to BACKER.')
    expect(console.log).toHaveBeenCalledWith('Confirmed in round 99.')
    expect(console.log).toHaveBeenCalledWith('Transaction: CLAIMTX')
    expect(console.log).toHaveBeenCalledWith('Explorer: https://lora.algokit.io/testnet/tx/CLAIMTX')
    expect(console.error).toHaveBeenCalledWith('Submitting: claim campaign 1…')
    expect(closeMock).toHaveBeenCalled()
  })

  it('omits the round and transaction lines when the node returns neither', async () => {
    sdkMocks.claim.mockResolvedValue({ txIds: [] })

    expect(await runClaim(claimOptions())).toBe(0)
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Confirmed in round'))
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Transaction:'))
  })

  it('does not print a Lora link on a custom network', async () => {
    expect(await runClaim(claimOptions({ network: 'custom' }))).toBe(0)
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Explorer:'))
  })

  it('prints the plan in a dry run without submitting', async () => {
    expect(await runClaim(claimOptions({ dryRun: true }))).toBe(0)

    expect(sdkMocks.claim).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would claim campaign 1 as BACKER.')
    expect(console.log).toHaveBeenCalledWith('Dry run: nothing submitted.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('rejects an open campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')

    await expect(runClaim(claimOptions())).rejects.toThrow('Campaign 1 is still open; claim opens after its deadline')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a failed campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')

    await expect(runClaim(claimOptions())).rejects.toThrow('Campaign 1 failed; there is nothing to claim')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects an already-claimed campaign before opening the wallet', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', status: 'claimed' })

    await expect(runClaim(claimOptions())).rejects.toThrow('Campaign 1 was already claimed')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a wallet that did not create the campaign', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'CREATOR' })

    await expect(runClaim(claimOptions())).rejects.toThrow('Campaign 1 was created by CREATOR; only the creator can claim')
    expect(sdkMocks.claim).not.toHaveBeenCalled()
    expect(closeMock).toHaveBeenCalled()
  })

  it('closes the session when the claim fails', async () => {
    sdkMocks.claim.mockRejectedValue(new Error('rejected'))

    await expect(runClaim(claimOptions())).rejects.toThrow('rejected')
    expect(closeMock).toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(runClaim({ command: 'claim', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'claim requires exactly one app id',
    )
  })
})

describe('runDelete', () => {
  function deleteOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return options({ command: 'delete', ...overrides })
  }

  beforeEach(() => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', status: 'claimed' })
  })

  it('deletes a claimed campaign and closes the session', async () => {
    expect(await runDelete(deleteOptions())).toBe(0)

    expect(sdkMocks.deleteCampaign).toHaveBeenCalledWith(1n, WALLET)
    expect(console.log).toHaveBeenCalledWith('Deleted campaign 1.')
    expect(console.log).toHaveBeenCalledWith("The campaign's schema MBR and any Registry registration deposit are back in your account.")
    expect(console.error).toHaveBeenCalledWith('Submitting: delete campaign 1…')
    expect(console.log).not.toHaveBeenCalledWith('Backers keep refunding from the vault until the refund window closes.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('deletes a failed campaign and notes that backers keep refunding', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 2_000_000n })

    expect(await runDelete(deleteOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith('Backers keep refunding from the vault until the refund window closes.')
  })

  it('deletes a failed campaign with nothing left to refund', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 0n })

    expect(await runDelete(deleteOptions())).toBe(0)

    expect(sdkMocks.deleteCampaign).toHaveBeenCalledWith(1n, WALLET)
    expect(console.log).not.toHaveBeenCalledWith('Backers keep refunding from the vault until the refund window closes.')
  })

  it('deletes a pristine open campaign before its deadline', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 0n })

    expect(await runDelete(deleteOptions())).toBe(0)
    expect(sdkMocks.deleteCampaign).toHaveBeenCalledWith(1n, WALLET)
  })

  it('prints the plan in a dry run without submitting', async () => {
    expect(await runDelete(deleteOptions({ dryRun: true }))).toBe(0)

    expect(sdkMocks.deleteCampaign).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would delete campaign 1 as BACKER.')
    expect(console.log).toHaveBeenCalledWith('Dry run: nothing submitted.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('rejects an already-deleted campaign before opening the wallet', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', deleted: true })

    await expect(runDelete(deleteOptions())).rejects.toThrow('Campaign 1 was already deleted')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a funded campaign that is not claimed yet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 10_000_000n })

    await expect(runDelete(deleteOptions())).rejects.toThrow('Campaign 1 reached its goal; claim it before deleting')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects an open campaign with live pledges', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('open')
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'BACKER', raisedMicroAlgos: 2_000_000n })

    await expect(runDelete(deleteOptions())).rejects.toThrow(
      'Campaign 1 is still open with live pledges; cancel them or wait for the deadline',
    )
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a wallet that did not create the campaign', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, creator: 'CREATOR', status: 'claimed' })

    await expect(runDelete(deleteOptions())).rejects.toThrow('Campaign 1 was created by CREATOR; only the creator can delete it')
    expect(sdkMocks.deleteCampaign).not.toHaveBeenCalled()
    expect(closeMock).toHaveBeenCalled()
  })

  it('closes the session when the deletion fails', async () => {
    sdkMocks.deleteCampaign.mockRejectedValue(new Error('rejected'))

    await expect(runDelete(deleteOptions())).rejects.toThrow('rejected')
    expect(closeMock).toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(runDelete({ command: 'delete', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'delete requires exactly one app id',
    )
  })
})

describe('runPledges', () => {
  function pledgeOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return options({ command: 'pledges', ...overrides })
  }

  beforeEach(() => {
    sdkMocks.enumerateCampaigns.mockResolvedValue(new Set([1n]))
    sdkMocks.getCampaignStatus.mockReturnValue('open')
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 1_500_000n)])
  })

  it('lists a live pledge with the withdraw action', async () => {
    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.error).toHaveBeenCalledWith('Searching testnet for live pledges by BACKER…')
    expect(console.log).toHaveBeenCalledWith('Live pledges by BACKER on testnet:')
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^app id\s+title\s+status\s+deadline\s+pledge\s+amount\s+action$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+open\s+1970-01-01 00:16 UTC\s+0\s+1\.5 ALGO\s+withdraw$/))
  })

  it('lists every pledge with the same format', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 500_000n), leaf(3, 1_000_000n)])

    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Title\s+open\s+1970-01-01 00:16 UTC\s+0\s+0\.5 ALGO\s+withdraw --pledge 0$/),
    )
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Title\s+open\s+1970-01-01 00:16 UTC\s+3\s+1 ALGO\s+withdraw --pledge 3$/),
    )
    expect(console.log).toHaveBeenCalledWith('Use --all to act on every pledge.')
  })

  it('lists a failed pledge with the refund action', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')

    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+failed\s+1970-01-01 00:16 UTC\s+0\s+1\.5 ALGO\s+refund$/))
  })

  it('marks each refundable pledge when several are live', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('failed')
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 500_000n), leaf(3, 1_000_000n)])

    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Title\s+failed\s+1970-01-01 00:16 UTC\s+0\s+0\.5 ALGO\s+refund --pledge 0$/),
    )
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Title\s+failed\s+1970-01-01 00:16 UTC\s+3\s+1 ALGO\s+refund --pledge 3$/),
    )
  })

  it('keeps every successful pledge visible with no action', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 500_000n), leaf(3, 1_000_000n)])

    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+successful\s+1970-01-01 00:16 UTC\s+0\s+0\.5 ALGO\s+-$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+successful\s+1970-01-01 00:16 UTC\s+3\s+1 ALGO\s+-$/))
  })

  it('lists a successful pledge with nothing to do', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')

    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+successful\s+1970-01-01 00:16 UTC\s+0\s+1\.5 ALGO\s+-$/))
  })

  it('keeps a deleted pledge visible with the refund window closed', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, deleted: true })

    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Title\s+open, deleted\s+1970-01-01 00:16 UTC\s+0\s+1\.5 ALGO\s+window closed$/),
    )
  })

  it('keeps a deleted pledge refundable while its box is open', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, deleted: true })
    sdkMocks.getCampaignStatus.mockReturnValue('failed')

    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Title\s+failed, deleted\s+1970-01-01 00:16 UTC\s+0\s+1\.5 ALGO\s+refund$/),
    )
  })

  it('reports no live pledges', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([])

    expect(await runPledges(pledgeOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith('No live pledges by BACKER on testnet.')
  })

  it('shows a state-only view for an explicit address', async () => {
    expect(await runPledges(pledgeOptions({ address: VALID_ADDRESS }))).toBe(0)

    expect(mnemonicSessionMock).not.toHaveBeenCalled()
    expect(whoamiMock).not.toHaveBeenCalled()
    expect(sdkMocks.fetchMyLeaves).toHaveBeenCalledWith(1n, VALID_ADDRESS)
    expect(console.log).toHaveBeenCalledWith("Read-only view; withdraw and refund need the pledge owner's wallet.")
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^app id\s+title\s+status\s+deadline\s+pledge\s+amount$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+open\s+1970-01-01 00:16 UTC\s+0\s+1\.5 ALGO$/))
    expect(console.log).not.toHaveBeenCalledWith(expect.stringMatching(/\swithdraw$/))
  })

  it('hides pledge actions in a read-only view with several pledges', async () => {
    sdkMocks.fetchMyLeaves.mockResolvedValue([leaf(0, 500_000n), leaf(3, 1_000_000n)])

    expect(await runPledges(pledgeOptions({ address: VALID_ADDRESS }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+open\s+1970-01-01 00:16 UTC\s+0\s+0\.5 ALGO$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+open\s+1970-01-01 00:16 UTC\s+3\s+1 ALGO$/))
    expect(console.log).not.toHaveBeenCalledWith('Use --all to act on every pledge.')
  })

  it('rejects an invalid address', async () => {
    await expect(runPledges(pledgeOptions({ address: 'ADDRESS' }))).rejects.toThrow('Invalid address: ADDRESS')
  })

  it('reads the address from the stored wallet session', async () => {
    whoamiMock.mockResolvedValue({ address: 'WALLET_ADDRESS' })

    expect(await runPledges(pledgeOptions({ signer: 'wallet' }))).toBe(0)

    expect(mnemonicSessionMock).not.toHaveBeenCalled()
    expect(sdkMocks.fetchMyLeaves).toHaveBeenCalledWith(1n, 'WALLET_ADDRESS')
  })

  it('requires a wallet session or an address', async () => {
    whoamiMock.mockResolvedValue(undefined)

    await expect(runPledges(pledgeOptions({ signer: 'wallet' }))).rejects.toThrow(
      'No active wallet session. Run `kasakame login` first, or pass --address',
    )
  })

  it('wraps indexer failures', async () => {
    sdkMocks.enumerateCampaigns.mockRejectedValue(new Error('indexer down'))

    await expect(runPledges(pledgeOptions())).rejects.toThrow('Could not read pledges from the indexer: indexer down')
  })
})

describe('runCampaigns', () => {
  function campaignOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return options({ command: 'campaigns', ...overrides })
  }

  function header(overrides: Record<string, unknown>) {
    return { ...HEADER, ...overrides }
  }

  it('lists the action available for each creator campaign', async () => {
    const headers = new Map<bigint, Record<string, unknown>>([
      [1n, header({ id: 1n, title: 'Claimed', creator: 'BACKER', status: 'claimed', raisedMicroAlgos: 10_000_000n })],
      [2n, header({ id: 2n, title: 'Funded', creator: 'BACKER', raisedMicroAlgos: 10_000_000n })],
      [3n, header({ id: 3n, title: 'Failed', creator: 'BACKER', goalMicroAlgos: 5_000_000n, raisedMicroAlgos: 2_000_000n })],
      [4n, header({ id: 4n, title: 'Empty', creator: 'BACKER', raisedMicroAlgos: 0n })],
      [5n, header({ id: 5n, title: 'Live', creator: 'BACKER', raisedMicroAlgos: 2_000_000n })],
      [6n, header({ id: 6n, title: 'Gone', creator: 'BACKER', deleted: true })],
      [7n, header({ id: 7n, title: 'Other', creator: 'OTHER' })],
    ])
    const statuses = new Map<bigint, string>([
      [1n, 'successful'],
      [2n, 'successful'],
      [3n, 'failed'],
      [4n, 'open'],
      [5n, 'open'],
      [6n, 'failed'],
      [7n, 'open'],
    ])
    sdkMocks.enumerateCampaigns.mockResolvedValue(new Set([1n, 2n, 3n, 4n, 5n, 6n, 7n]))
    sdkMocks.fetchCampaignHeader.mockImplementation((id: bigint) => headers.get(id))
    sdkMocks.getCampaignStatus.mockImplementation((entry: { id: bigint }) => statuses.get(entry.id))

    expect(await runCampaigns(campaignOptions())).toBe(0)

    expect(console.error).toHaveBeenCalledWith('Searching testnet for campaigns created by BACKER…')
    expect(console.log).toHaveBeenCalledWith('Campaigns created by BACKER on testnet:')
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^app id\s+title\s+status\s+raised \/ goal\s+deadline\s+action$/))
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^1\s+Claimed\s+successful \(claimed\)\s+10 \/ 10 ALGO\s+1970-01-01 00:16 UTC\s+delete$/),
    )
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^2\s+Funded\s+successful\s+10 \/ 10 ALGO\s+1970-01-01 00:16 UTC\s+claim$/),
    )
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^3\s+Failed\s+failed\s+2 \/ 5 ALGO\s+1970-01-01 00:16 UTC\s+delete$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^4\s+Empty\s+open\s+0 \/ 10 ALGO\s+1970-01-01 00:16 UTC\s+delete$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^5\s+Live\s+open\s+2 \/ 10 ALGO\s+1970-01-01 00:16 UTC\s+-$/))
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^6\s+Gone\s+failed, deleted\s+2 \/ 10 ALGO\s+1970-01-01 00:16 UTC\s+-$/),
    )
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Other'))
  })

  it('reports no campaigns for the address', async () => {
    sdkMocks.enumerateCampaigns.mockResolvedValue(new Set())

    expect(await runCampaigns(campaignOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith('No campaigns created by BACKER on testnet.')
  })

  it('hides creator actions in a read-only view', async () => {
    sdkMocks.enumerateCampaigns.mockResolvedValue(new Set([1n]))
    sdkMocks.fetchCampaignHeader.mockResolvedValue(header({ creator: VALID_ADDRESS, raisedMicroAlgos: 0n }))
    sdkMocks.getCampaignStatus.mockReturnValue('open')

    expect(await runCampaigns(campaignOptions({ address: VALID_ADDRESS }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith("Read-only view; claim and delete need the creator's wallet.")
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^app id\s+title\s+status\s+raised \/ goal\s+deadline$/))
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+open\s+0 \/ 10 ALGO\s+1970-01-01 00:16 UTC$/))
    expect(console.log).not.toHaveBeenCalledWith(expect.stringMatching(/\sdelete$/))
  })

  it('skips ids the indexer does not know', async () => {
    sdkMocks.enumerateCampaigns.mockResolvedValue(new Set([1n, 2n, 3n]))
    sdkMocks.fetchCampaignHeader.mockImplementation((id: bigint) => {
      if (id === 1n) return header({ creator: 'BACKER', raisedMicroAlgos: 0n })
      if (id === 2n) return undefined
      throw new Error('no application found for application-id: 3')
    })
    sdkMocks.getCampaignStatus.mockReturnValue('open')

    expect(await runCampaigns(campaignOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith('Campaigns created by BACKER on testnet:')
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^1\s+Title\s+open\s+0 \/ 10 ALGO\s+1970-01-01 00:16 UTC\s+delete$/))
  })

  it('wraps indexer failures', async () => {
    sdkMocks.fetchCampaignHeader.mockRejectedValue(new Error('indexer down'))

    await expect(runCampaigns(campaignOptions())).rejects.toThrow('Could not read campaigns from the indexer: indexer down')
  })
})

describe('runSettleOpen', () => {
  function settleOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return options({ command: 'settle-open', ...overrides })
  }

  it('settles an open campaign and closes the session', async () => {
    expect(await runSettleOpen(settleOptions())).toBe(0)

    expect(sdkMocks.settleOpen).toHaveBeenCalledWith(1n, WALLET)
    expect(console.error).toHaveBeenCalledWith('Submitting: settle open campaign 1…')
    expect(console.log).toHaveBeenCalledWith('Settled campaign 1 as failed; backers can now refund through the vault.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('prints the plan in a dry run without submitting', async () => {
    expect(await runSettleOpen(settleOptions({ dryRun: true }))).toBe(0)

    expect(sdkMocks.settleOpen).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would settle campaign 1 as failed.')
    expect(console.log).toHaveBeenCalledWith('Dry run: nothing submitted.')
    expect(closeMock).toHaveBeenCalled()
  })

  it('rejects a deleted campaign before opening the wallet', async () => {
    sdkMocks.fetchCampaignHeader.mockResolvedValue({ ...HEADER, deleted: true })

    await expect(runSettleOpen(settleOptions())).rejects.toThrow(
      'Campaign 1 was already deleted; deleting a failed campaign settles its vault box',
    )
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a successful campaign before opening the wallet', async () => {
    sdkMocks.getCampaignStatus.mockReturnValue('successful')

    await expect(runSettleOpen(settleOptions())).rejects.toThrow('Campaign 1 reached its goal; there is nothing to settle')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a campaign without a vault box', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(undefined)

    await expect(runSettleOpen(settleOptions())).rejects.toThrow('Campaign 1 has no vault box; there is nothing to settle')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a box that is already settled', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_FAILED))

    await expect(runSettleOpen(settleOptions())).rejects.toThrow('Campaign 1 is already settled; backers can refund it')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a box that is not open', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_CLAIMED))

    await expect(runSettleOpen(settleOptions())).rejects.toThrow('Campaign 1 was not failed; there is nothing to settle')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('closes the session when the settlement fails', async () => {
    sdkMocks.settleOpen.mockRejectedValue(new Error('rejected'))

    await expect(runSettleOpen(settleOptions())).rejects.toThrow('rejected')
    expect(closeMock).toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(runSettleOpen({ command: 'settle-open', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'settle-open requires exactly one app id',
    )
  })
})

describe('runReleaseClaimed', () => {
  function releaseOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return options({ command: 'release-claimed', ...overrides })
  }

  it('releases a claimed campaign box and closes the session', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_CLAIMED, { paidOut: 2_000_000n }))

    expect(await runReleaseClaimed(releaseOptions())).toBe(0)

    expect(sdkMocks.releaseClaimed).toHaveBeenCalledWith(1n, WALLET)
    expect(console.error).toHaveBeenCalledWith('Submitting: release the vault box for claimed campaign 1…')
    expect(console.log).toHaveBeenCalledWith("Released the vault box for campaign 1; its minimum balance is back in the vault's account.")
    expect(closeMock).toHaveBeenCalled()
  })

  it('prints the plan in a dry run without submitting', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_CLAIMED))

    expect(await runReleaseClaimed(releaseOptions({ dryRun: true }))).toBe(0)

    expect(sdkMocks.releaseClaimed).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Would release the vault box for claimed campaign 1.')
    expect(console.log).toHaveBeenCalledWith('Dry run: nothing submitted.')
  })

  it('reports a missing box without opening the wallet', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(undefined)

    expect(await runReleaseClaimed(releaseOptions())).toBe(0)

    expect(console.log).toHaveBeenCalledWith('Campaign 1 has no vault box; there is nothing to release.')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a box that is not claimed before opening the wallet', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_OPEN))

    await expect(runReleaseClaimed(releaseOptions())).rejects.toThrow(
      "Campaign 1 is not claimed; only a claimed campaign's vault box can be released",
    )
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('closes the session when the release fails', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_CLAIMED))
    sdkMocks.releaseClaimed.mockRejectedValue(new Error('rejected'))

    await expect(runReleaseClaimed(releaseOptions())).rejects.toThrow('rejected')
    expect(closeMock).toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(runReleaseClaimed({ command: 'release-claimed', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'release-claimed requires exactly one app id',
    )
  })
})

describe('runFinalize', () => {
  function finalizeOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return options({ command: 'finalize', ...overrides })
  }

  it('sweeps the residual after the refund window and closes the session', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_FAILED, { paidOut: 1_000_000n }))

    expect(await runFinalize(finalizeOptions())).toBe(0)

    expect(sdkMocks.finalize).toHaveBeenCalledWith(1n, WALLET)
    expect(console.error).toHaveBeenCalledWith('Submitting: finalize campaign 1…')
    expect(console.log).toHaveBeenCalledWith("Swept 1 ALGO to the vault's sweep target and released the vault box for campaign 1.")
    expect(closeMock).toHaveBeenCalled()
  })

  it('finalizes a fully paid-out box without reading the refund window', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_FAILED, { paidOut: 2_000_000n }))

    expect(await runFinalize(finalizeOptions())).toBe(0)

    expect(sdkMocks.fetchVaultConfig).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Released the vault box for campaign 1; there was nothing left to sweep.')
  })

  it('prints the plan in a dry run without submitting', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_FAILED, { paidOut: 1_000_000n }))

    expect(await runFinalize(finalizeOptions({ dryRun: true }))).toBe(0)

    expect(sdkMocks.finalize).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith("Would finalize campaign 1 and sweep 1 ALGO to the vault's sweep target.")
    expect(console.log).toHaveBeenCalledWith('Dry run: nothing submitted.')
  })

  it('prints the release plan for a fully paid-out box in a dry run', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_FAILED, { paidOut: 2_000_000n }))

    expect(await runFinalize(finalizeOptions({ dryRun: true }))).toBe(0)

    expect(console.log).toHaveBeenCalledWith('Would finalize campaign 1 and release its vault box.')
  })

  it('rejects while the refund window is still open', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_FAILED, { paidOut: 1_000_000n, settledAt: 1_950n }))

    await expect(runFinalize(finalizeOptions())).rejects.toThrow(
      'The refund window for campaign 1 is open until 1970-01-01 00:34 UTC; backers can still refund',
    )
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a campaign without a vault box', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(undefined)

    await expect(runFinalize(finalizeOptions())).rejects.toThrow('Campaign 1 has no vault box; it was already finalized or never funded')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a box that is not failed', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_CLAIMED))

    await expect(runFinalize(finalizeOptions())).rejects.toThrow('Campaign 1 is not settled as failed; there is nothing to finalize')
    expect(openCliSessionMock).not.toHaveBeenCalled()
  })

  it('closes the session when finalization fails', async () => {
    sdkMocks.fetchVaultBox.mockResolvedValue(vaultBox(VAULT_FAILED, { paidOut: 1_000_000n }))
    sdkMocks.finalize.mockRejectedValue(new Error('rejected'))

    await expect(runFinalize(finalizeOptions())).rejects.toThrow('rejected')
    expect(closeMock).toHaveBeenCalled()
  })

  it('requires an app id', async () => {
    await expect(runFinalize({ command: 'finalize', network: 'testnet', signer: 'mnemonic', dryRun: false })).rejects.toThrow(
      'finalize requires exactly one app id',
    )
  })
})
