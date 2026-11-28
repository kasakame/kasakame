import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO, MIN_REFUND_WINDOW_SECONDS, SECONDS_PER_DAY, VAULT_BOX_MBR_MICRO_ALGOS } from '@kasakame/constants'
import { claim, deleteCampaign, fetchChainTimestamp, pledge, refund, settleOpen, waitForIndexerCatchUp } from '@kasakame/sdk'
import { accountInfo, advanceTime, assertAccountDelta } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  TEST_DEADLINE_SECONDS,
  advancePastDeadline,
  campaignState,
  createTestCampaign,
  expectCliError,
  expectCliOk,
  headerOf,
  leavesOf,
  newSigner,
  runCli,
  setupCliStack,
  type CliSigner,
  type CliStack,
} from './utils/index.js'

describe('CLI vault cleanup (localnet)', () => {
  const fixture = algorandFixture()
  let stack: CliStack
  const DAY = BigInt(SECONDS_PER_DAY)

  beforeAll(async () => {
    stack = await setupCliStack(fixture)
  })

  function options(signer: CliSigner) {
    return { mnemonic: signer.mnemonic, vaultAppId: stack.vaultAppId, registryAppId: stack.registryAppId }
  }

  async function failedCampaign(creator: CliSigner, backer: CliSigner, amounts: bigint[]) {
    const deadline = (await fetchChainTimestamp()) + DAY + 60n
    const { appId } = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, { deadline })
    for (const amount of amounts) await pledge(appId, backer.wallet, amount)
    await advancePastDeadline(fixture, deadline)
    return appId
  }

  test('CLI-040 settle-open makes a failed campaign refundable by the vault', { tags: ['smoke', 'happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const stranger = await newSigner(fixture)
    const appId = await failedCampaign(creator, backer, [2n * MICRO_ALGOS_PER_ALGO])

    const vaultBefore = await accountInfo(stack.algorand, stack.vaultAddress)
    const strangerBefore = await accountInfo(stack.algorand, stranger.address)
    const settled = await runCli(['settle-open', appId.toString()], options(stranger))
    expectCliOk(settled)
    expect(settled.stdout).toContain(`Settled campaign ${appId.toString()} as failed; backers can now refund through the vault.`)
    expect(settled.stdout).toContain('Confirmed in round')
    assertAccountDelta('stranger', strangerBefore, await accountInfo(stack.algorand, stranger.address), {
      balance: -stack.minFee,
    })
    assertAccountDelta('vault', vaultBefore, await accountInfo(stack.algorand, stack.vaultAddress), { minBalance: 0n })
    expect((await campaignState(appId, backer.address)).box).toMatchObject({ status: 2, paidIn: 2n * MICRO_ALGOS_PER_ALGO })

    const refunded = await runCli(['refund', appId.toString(), '--all'], options(backer))
    expectCliOk(refunded)
    expect(refunded.stdout).toContain('Refunded 1 pledge.')
    expect(await leavesOf(appId, backer.address)).toEqual([])
    expect((await campaignState(appId, backer.address)).box).toMatchObject({ paidOut: 2n * MICRO_ALGOS_PER_ALGO })
  })

  test('CLI-041 settle-open guards and dry-run', { tags: ['bad', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)

    const open = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, {
      deadline: (await fetchChainTimestamp()) + TEST_DEADLINE_SECONDS,
    })
    await pledge(open.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const openSnapshot = await campaignState(open.appId, backer.address)
    const openResult = await runCli(['settle-open', open.appId.toString()], options(backer))
    expectCliError(openResult, 'The deadline has not passed yet.')
    expect(await campaignState(open.appId, backer.address)).toEqual(openSnapshot)

    const deadline = (await fetchChainTimestamp()) + DAY + 60n
    const successful = await createTestCampaign(creator.wallet, MICRO_ALGOS_PER_ALGO, { deadline })
    await pledge(successful.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const failed = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, { deadline })
    await pledge(failed.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const settled = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, { deadline })
    await pledge(settled.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const deleted = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, { deadline })
    await pledge(deleted.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await advancePastDeadline(fixture, deadline)
    await settleOpen(settled.appId, creator.wallet)
    await deleteCampaign(deleted.appId, creator.wallet)
    await waitForIndexerCatchUp()

    const successfulResult = await runCli(['settle-open', successful.appId.toString()], options(backer))
    expectCliError(successfulResult, `Campaign ${successful.appId.toString()} reached its goal; there is nothing to settle`)

    const deletedResult = await runCli(['settle-open', deleted.appId.toString()], options(backer))
    expectCliError(deletedResult, `Campaign ${deleted.appId.toString()} was already deleted`)

    const settledResult = await runCli(['settle-open', settled.appId.toString()], options(backer))
    expectCliError(settledResult, `Campaign ${settled.appId.toString()} is already settled; backers can refund it`)

    const pristine = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO)
    const missingBox = await runCli(['settle-open', pristine.appId.toString()], options(backer))
    expectCliError(missingBox, `Campaign ${pristine.appId.toString()} has no vault box; there is nothing to settle`)

    const failedSnapshot = await campaignState(failed.appId, backer.address)
    const dryRun = await runCli(['settle-open', failed.appId.toString(), '--dry-run'], options(backer))
    expectCliOk(dryRun)
    expect(dryRun.stdout).toContain(`Would settle campaign ${failed.appId.toString()} as failed.`)
    expect(dryRun.stdout).toContain('Dry run: nothing submitted.')
    expect(await campaignState(failed.appId, backer.address)).toEqual(failedSnapshot)
  })

  test('CLI-042 finalize sweeps the residual after the refund window', { tags: ['smoke', 'happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const stranger = await newSigner(fixture)
    const appId = await failedCampaign(creator, backer, [2n * MICRO_ALGOS_PER_ALGO, MICRO_ALGOS_PER_ALGO])
    await settleOpen(appId, creator.wallet)
    await waitForIndexerCatchUp()
    const leaf = (await leavesOf(appId, backer.address))[0]
    if (leaf === undefined) throw new Error('missing refundable leaf')
    await refund(appId, backer.wallet, leaf)
    await waitForIndexerCatchUp()
    await advanceTime(fixture, MIN_REFUND_WINDOW_SECONDS + 4_000)

    const sweeperBefore = await accountInfo(stack.algorand, stack.sweepTarget)
    const vaultBefore = await accountInfo(stack.algorand, stack.vaultAddress)
    const strangerBefore = await accountInfo(stack.algorand, stranger.address)
    const result = await runCli(['finalize', appId.toString()], options(stranger))
    expectCliOk(result)
    expect(result.stdout).toContain(`Swept 1 ALGO to the vault's sweep target and released the vault box for campaign ${appId.toString()}.`)
    assertAccountDelta('sweep target', sweeperBefore, await accountInfo(stack.algorand, stack.sweepTarget), {
      balance: MICRO_ALGOS_PER_ALGO,
    })
    assertAccountDelta('vault', vaultBefore, await accountInfo(stack.algorand, stack.vaultAddress), {
      minBalance: -VAULT_BOX_MBR_MICRO_ALGOS,
    })
    assertAccountDelta('stranger', strangerBefore, await accountInfo(stack.algorand, stranger.address), {
      balance: -2n * stack.minFee,
    })
    expect((await campaignState(appId, backer.address)).box).toBeUndefined()
  })

  test('CLI-043 finalize releases a fully paid-out box before the window', { tags: ['happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const stranger = await newSigner(fixture)
    const appId = await failedCampaign(creator, backer, [MICRO_ALGOS_PER_ALGO])
    await settleOpen(appId, creator.wallet)
    await waitForIndexerCatchUp()
    const leaf = (await leavesOf(appId, backer.address))[0]
    if (leaf === undefined) throw new Error('missing refundable leaf')
    await refund(appId, backer.wallet, leaf)
    await waitForIndexerCatchUp()

    const dryRun = await runCli(['finalize', appId.toString(), '--dry-run'], options(stranger))
    expectCliOk(dryRun)
    expect(dryRun.stdout).toContain(`Would finalize campaign ${appId.toString()} and release its vault box.`)
    expect(dryRun.stdout).toContain('Dry run: nothing submitted.')
    expect((await campaignState(appId, backer.address)).box).toBeDefined()

    const vaultBefore = await accountInfo(stack.algorand, stack.vaultAddress)
    const strangerBefore = await accountInfo(stack.algorand, stranger.address)
    const result = await runCli(['finalize', appId.toString()], options(stranger))
    expectCliOk(result)
    expect(result.stdout).toContain(`Released the vault box for campaign ${appId.toString()}; there was nothing left to sweep.`)
    assertAccountDelta('vault', vaultBefore, await accountInfo(stack.algorand, stack.vaultAddress), {
      minBalance: -VAULT_BOX_MBR_MICRO_ALGOS,
    })
    assertAccountDelta('stranger', strangerBefore, await accountInfo(stack.algorand, stranger.address), {
      balance: -stack.minFee,
    })
    expect((await campaignState(appId, backer.address)).box).toBeUndefined()
  })

  test('CLI-044 finalize guards', { tags: ['bad', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const stranger = await newSigner(fixture)

    const open = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, {
      deadline: (await fetchChainTimestamp()) + TEST_DEADLINE_SECONDS,
    })
    await pledge(open.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const openResult = await runCli(['finalize', open.appId.toString()], options(stranger))
    expectCliError(openResult, `Campaign ${open.appId.toString()} is not settled as failed; there is nothing to finalize`)

    const pristine = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO)
    const missingBox = await runCli(['finalize', pristine.appId.toString()], options(stranger))
    expectCliError(missingBox, `Campaign ${pristine.appId.toString()} has no vault box; it was already finalized or never funded`)

    const failed = await failedCampaign(creator, backer, [MICRO_ALGOS_PER_ALGO])
    await settleOpen(failed, creator.wallet)
    await waitForIndexerCatchUp()
    const failedSnapshot = await campaignState(failed, backer.address)
    const before = await accountInfo(stack.algorand, stranger.address)
    const openWindow = await runCli(['finalize', failed.toString()], options(stranger))
    expectCliError(openWindow, `The refund window for campaign ${failed.toString()} is open until`)
    expect(await campaignState(failed, backer.address)).toEqual(failedSnapshot)
    assertAccountDelta('stranger', before, await accountInfo(stack.algorand, stranger.address), { balance: 0n })

    const claimedDeadline = (await fetchChainTimestamp()) + DAY + 60n
    const claimed = await createTestCampaign(creator.wallet, MICRO_ALGOS_PER_ALGO, { deadline: claimedDeadline })
    await pledge(claimed.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await advancePastDeadline(fixture, claimedDeadline)
    await claim(claimed.appId, creator.wallet)
    const claimedResult = await runCli(['finalize', claimed.appId.toString()], options(stranger))
    expectCliError(claimedResult, `Campaign ${claimed.appId.toString()} is not settled as failed; there is nothing to finalize`)
  })

  test('CLI-045 release-claimed frees a claimed box permissionlessly', { tags: ['happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const stranger = await newSigner(fixture)
    const deadline = (await fetchChainTimestamp()) + DAY + 60n
    const { appId } = await createTestCampaign(creator.wallet, MICRO_ALGOS_PER_ALGO, { deadline })
    await pledge(appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await advancePastDeadline(fixture, deadline)
    await claim(appId, creator.wallet)
    await waitForIndexerCatchUp()

    const vaultBefore = await accountInfo(stack.algorand, stack.vaultAddress)
    const strangerBefore = await accountInfo(stack.algorand, stranger.address)
    const result = await runCli(['release-claimed', appId.toString()], options(stranger))
    expectCliOk(result)
    expect(result.stdout).toContain(
      `Released the vault box for campaign ${appId.toString()}; its minimum balance is back in the vault's account.`,
    )
    assertAccountDelta('vault', vaultBefore, await accountInfo(stack.algorand, stack.vaultAddress), {
      minBalance: -VAULT_BOX_MBR_MICRO_ALGOS,
    })
    assertAccountDelta('stranger', strangerBefore, await accountInfo(stack.algorand, stranger.address), {
      balance: -stack.minFee,
    })
    expect((await campaignState(appId, backer.address)).box).toBeUndefined()
    expect(await headerOf(appId)).toBeDefined()
  })

  test('CLI-046 release-claimed missing and not-claimed boxes', { tags: ['bad', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const stranger = await newSigner(fixture)

    const pristine = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO)
    const missing = await runCli(['release-claimed', pristine.appId.toString()], options(stranger))
    expectCliOk(missing)
    expect(missing.stdout).toContain(`Campaign ${pristine.appId.toString()} has no vault box; there is nothing to release.`)
    expect(missing.stderr).not.toContain('Submitting')

    const open = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, {
      deadline: (await fetchChainTimestamp()) + TEST_DEADLINE_SECONDS,
    })
    await pledge(open.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const openResult = await runCli(['release-claimed', open.appId.toString()], options(stranger))
    expectCliError(openResult, `Campaign ${open.appId.toString()} is not claimed; only a claimed campaign's vault box can be released`)

    const failed = await failedCampaign(creator, backer, [MICRO_ALGOS_PER_ALGO])
    const failedResult = await runCli(['release-claimed', failed.toString()], options(stranger))
    expectCliError(failedResult, `Campaign ${failed.toString()} is not claimed; only a claimed campaign's vault box can be released`)

    const claimedDeadline = (await fetchChainTimestamp()) + DAY + 60n
    const claimed = await createTestCampaign(creator.wallet, MICRO_ALGOS_PER_ALGO, { deadline: claimedDeadline })
    await pledge(claimed.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await advancePastDeadline(fixture, claimedDeadline)
    await claim(claimed.appId, creator.wallet)
    await waitForIndexerCatchUp()
    const claimedSnapshot = await campaignState(claimed.appId, backer.address)
    const dryRun = await runCli(['release-claimed', claimed.appId.toString(), '--dry-run'], options(stranger))
    expectCliOk(dryRun)
    expect(dryRun.stdout).toContain(`Would release the vault box for claimed campaign ${claimed.appId.toString()}.`)
    expect(dryRun.stdout).toContain('Dry run: nothing submitted.')
    expect(await campaignState(claimed.appId, backer.address)).toEqual(claimedSnapshot)
  })

  test('CLI-047 refund rejects a closed refund window', { tags: ['bad', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const appId = await failedCampaign(creator, backer, [2n * MICRO_ALGOS_PER_ALGO])
    await settleOpen(appId, creator.wallet)
    await waitForIndexerCatchUp()
    await advanceTime(fixture, MIN_REFUND_WINDOW_SECONDS + 4_000)

    const snapshot = await campaignState(appId, backer.address)
    const before = await accountInfo(stack.algorand, backer.address)
    const result = await runCli(['refund', appId.toString(), '--all'], options(backer))
    expectCliError(result, /The refund window has closed\.|Could not refund the pledges\. Please try again\./)
    expect(await campaignState(appId, backer.address)).toEqual(snapshot)
    assertAccountDelta('backer', before, await accountInfo(stack.algorand, backer.address), { balance: 0n })
  })
})
