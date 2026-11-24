import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO, MIN_REFUND_WINDOW_SECONDS, VAULT_BOX_MBR_MICRO_ALGOS } from '@kasakame/constants'
import { accountInfo, advanceTime, assertAccountDelta, assertRejectedUnchanged } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  claim,
  deleteCampaign,
  fetchMyLeaves,
  fetchVaultBox,
  fetchVaultConfig,
  finalize,
  isRegistered,
  pledge,
  refund,
  releaseClaimed,
  settleOpen,
} from '../src/index.js'
import {
  advancePastDeadline,
  createTestCampaign,
  expectLeaves,
  expectVaultBox,
  leafAt,
  session,
  setupSdkStack,
  vaultSpendFee,
  type SdkStack,
} from './utils/index.js'

describe('SDK permissionless cleanup (localnet)', () => {
  const fixture = algorandFixture()
  let stack: SdkStack

  beforeAll(async () => {
    stack = await setupSdkStack(fixture)
  })

  test('SDK-050 settleOpen → vault refund → residual finalize → releaseClaimed', { tags: ['happy', 'always'] }, async () => {
    const creator = await session(fixture, 50n)
    const backer = await session(fixture, 50n)
    const stranger = await session(fixture, 50n)
    const { appId } = await createTestCampaign(creator, 10n * MICRO_ALGOS_PER_ALGO)
    const refundedAmount = 2n * MICRO_ALGOS_PER_ALGO
    const residualAmount = MICRO_ALGOS_PER_ALGO
    await pledge(appId, backer, refundedAmount)
    await pledge(appId, backer, residualAmount)
    const vaultBeforeSettle = await accountInfo(stack.algorand, stack.vaultAddress)
    await advancePastDeadline(fixture)

    // settleOpen: vault outer only, so the stranger pays one minimum fee and the box MBR stays parked.
    const strangerBeforeSettle = await accountInfo(stack.algorand, stranger.address)
    await settleOpen(appId, stranger)
    const strangerAfterSettle = await accountInfo(stack.algorand, stranger.address)
    assertAccountDelta('stranger', strangerBeforeSettle, strangerAfterSettle, { balance: -stack.minFee, minBalance: 0n })
    const settled = await fetchVaultBox(appId)
    expectVaultBox(settled, { status: 2, paidIn: refundedAmount + residualAmount, paidOut: 0n })
    const vaultAfterSettle = await accountInfo(stack.algorand, stack.vaultAddress)
    assertAccountDelta('vault', vaultBeforeSettle, vaultAfterSettle, { minBalance: 0n })

    // Post-settle refund: vault outer + one payout inner + the OpUp takes for this shape.
    const leaf = leafAt(await fetchMyLeaves(appId, backer.address), 0)
    const backerBeforeRefund = await accountInfo(stack.algorand, backer.address)
    await refund(appId, backer, leaf)
    const backerAfterRefund = await accountInfo(stack.algorand, backer.address)
    assertAccountDelta('backer', backerBeforeRefund, backerAfterRefund, {
      balance: leaf.amount - vaultSpendFee(stack.minFee, 2n, 0n),
      minBalance: 0n,
    })
    expectLeaves(await fetchMyLeaves(appId, backer.address), [{ position: 1, amount: residualAmount }])
    const afterRefund = await fetchVaultBox(appId)
    expectVaultBox(afterRefund, { paidIn: refundedAmount + residualAmount, paidOut: refundedAmount })

    await assertRejectedUnchanged(
      () => finalize(appId, stranger),
      async () => ({
        stranger: await accountInfo(stack.algorand, stranger.address),
        box: await fetchVaultBox(appId),
      }),
      /refund window still open/,
    )

    // Residual finalize after the window: outer fee plus the one sweep inner; the vault box MBR returns.
    const { window, sweepTarget } = await fetchVaultConfig()
    expect(window).toEqual(BigInt(MIN_REFUND_WINDOW_SECONDS))
    const sweeperBefore = await accountInfo(stack.algorand, sweepTarget)
    const vaultBeforeFinalize = await accountInfo(stack.algorand, stack.vaultAddress)
    const strangerBeforeFinalize = await accountInfo(stack.algorand, stranger.address)
    await advanceTime(fixture, MIN_REFUND_WINDOW_SECONDS + 4_000)
    await finalize(appId, stranger)
    const sweeperAfter = await accountInfo(stack.algorand, sweepTarget)
    const vaultAfterFinalize = await accountInfo(stack.algorand, stack.vaultAddress)
    const strangerAfterFinalize = await accountInfo(stack.algorand, stranger.address)
    assertAccountDelta('sweeper', sweeperBefore, sweeperAfter, { balance: residualAmount, minBalance: 0n })
    assertAccountDelta('stranger', strangerBeforeFinalize, strangerAfterFinalize, { balance: -2n * stack.minFee })
    assertAccountDelta('vault', vaultBeforeFinalize, vaultAfterFinalize, { minBalance: -VAULT_BOX_MBR_MICRO_ALGOS })
    expect(await fetchVaultBox(appId)).toBeUndefined()

    // releaseClaimed: a stranger frees a fully paid-out Claimed box; the creator can still delete afterwards.
    const { appId: successId } = await createTestCampaign(creator, MICRO_ALGOS_PER_ALGO)
    await pledge(successId, backer, MICRO_ALGOS_PER_ALGO)
    await advancePastDeadline(fixture)
    await claim(successId, creator)
    expectVaultBox(await fetchVaultBox(successId), {
      status: 3,
      paidIn: MICRO_ALGOS_PER_ALGO,
      paidOut: MICRO_ALGOS_PER_ALGO,
    })

    const vaultBeforeRelease = await accountInfo(stack.algorand, stack.vaultAddress)
    const strangerBeforeRelease = await accountInfo(stack.algorand, stranger.address)
    await releaseClaimed(successId, stranger)
    const vaultAfterRelease = await accountInfo(stack.algorand, stack.vaultAddress)
    const strangerAfterRelease = await accountInfo(stack.algorand, stranger.address)
    assertAccountDelta('stranger', strangerBeforeRelease, strangerAfterRelease, { balance: -stack.minFee })
    assertAccountDelta('vault', vaultBeforeRelease, vaultAfterRelease, { minBalance: -VAULT_BOX_MBR_MICRO_ALGOS })
    expect(await fetchVaultBox(successId)).toBeUndefined()

    await deleteCampaign(successId, creator)
    expect(await isRegistered(successId)).toBe(false)
    await expect(stack.algorand.app.getById(successId)).rejects.toThrow()
  })
})
