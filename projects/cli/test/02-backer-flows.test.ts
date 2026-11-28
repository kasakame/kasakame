import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO, SECONDS_PER_DAY } from '@kasakame/constants'
import { deleteCampaign, fetchChainTimestamp, pledge, waitForIndexerCatchUp } from '@kasakame/sdk'
import { accountInfo, assertAccountDelta } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  TEST_DEADLINE_SECONDS,
  advancePastDeadline,
  advanceTo,
  campaignSpendFee,
  campaignState,
  createTestCampaign,
  expectCliError,
  expectCliOk,
  headerOf,
  leavesOf,
  newSigner,
  runCli,
  setupCliStack,
  vaultSpendFee,
  type CliSigner,
  type CliStack,
} from './utils/index.js'

describe('CLI backer flows (localnet)', () => {
  const fixture = algorandFixture()
  let stack: CliStack
  const DAY = BigInt(SECONDS_PER_DAY)

  beforeAll(async () => {
    stack = await setupCliStack(fixture)
  })

  function options(signer: CliSigner) {
    return { mnemonic: signer.mnemonic, vaultAppId: stack.vaultAppId, registryAppId: stack.registryAppId }
  }

  test('CLI-020 withdraw returns one live pledge', { tags: ['smoke', 'happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const { appId } = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO)
    const amount = 3n * MICRO_ALGOS_PER_ALGO
    await pledge(appId, backer.wallet, amount)

    const before = await accountInfo(stack.algorand, backer.address)
    const result = await runCli(['withdraw', appId.toString()], options(backer))
    expectCliOk(result)
    expect(result.stdout).toContain('Withdrawn pledge #0 (3 ALGO).')
    expect(result.stdout).toContain('Withdrawn 1 pledge.')
    expect(result.stdout).toContain('Confirmed in round')
    expect(result.stdout).toContain('Transaction:')
    expect(result.stdout).toContain('Explorer: https://lora.algokit.io/localnet/tx/')
    expect(result.stderr).toContain('Submitting: withdraw pledge #0 (3 ALGO)…')

    const after = await accountInfo(stack.algorand, backer.address)
    assertAccountDelta('backer', before, after, { balance: amount - campaignSpendFee(stack.minFee, 1n, 0n) })
    expect(await leavesOf(appId, backer.address)).toEqual([])
    expect((await headerOf(appId))?.raisedMicroAlgos).toEqual(0n)
  })

  test('CLI-021 withdraw selection matches real positions', { tags: ['happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const { appId } = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO)
    const first = MICRO_ALGOS_PER_ALGO
    const second = 2n * MICRO_ALGOS_PER_ALGO
    await pledge(appId, backer.wallet, first)
    await pledge(appId, backer.wallet, second)
    const snapshot = await campaignState(appId, backer.address)

    const unselected = await runCli(['withdraw', appId.toString()], options(backer))
    expectCliError(unselected, `You have 2 live pledges in campaign ${appId.toString()}; pass --pledge <position> or --all`)
    expect(await campaignState(appId, backer.address)).toEqual(snapshot)

    const missing = await runCli(['withdraw', appId.toString(), '--pledge', '9'], options(backer))
    expectCliError(missing, `No live pledge #9 in campaign ${appId.toString()}`)
    expect(await campaignState(appId, backer.address)).toEqual(snapshot)

    const secondBefore = await accountInfo(stack.algorand, backer.address)
    const selected = await runCli(['withdraw', appId.toString(), '--pledge', '1'], options(backer))
    expectCliOk(selected)
    expect(selected.stdout).toContain('Withdrawn pledge #1 (2 ALGO).')
    const secondAfter = await accountInfo(stack.algorand, backer.address)
    assertAccountDelta('backer', secondBefore, secondAfter, { balance: second - campaignSpendFee(stack.minFee, 2n, 1n) })
    expect((await leavesOf(appId, backer.address)).map((leaf) => leaf.position)).toEqual([0])

    const firstBefore = await accountInfo(stack.algorand, backer.address)
    const all = await runCli(['withdraw', appId.toString(), '--all'], options(backer))
    expectCliOk(all)
    expect(all.stdout).toContain('Withdrawn pledge #0 (1 ALGO).')
    expect(all.stdout).toContain('Withdrawn 1 pledge.')
    const firstAfter = await accountInfo(stack.algorand, backer.address)
    assertAccountDelta('backer', firstBefore, firstAfter, { balance: first - campaignSpendFee(stack.minFee, 2n, 0n) })
    expect(await leavesOf(appId, backer.address)).toEqual([])
    expect((await headerOf(appId))?.raisedMicroAlgos).toEqual(0n)
  })

  test('CLI-022 withdraw dry-run and empty wallet', { tags: ['happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const stranger = await newSigner(fixture)
    const { appId } = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO)
    await pledge(appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await pledge(appId, backer.wallet, 2n * MICRO_ALGOS_PER_ALGO)
    const snapshot = await campaignState(appId, backer.address)
    const before = await accountInfo(stack.algorand, backer.address)

    const dryRun = await runCli(['withdraw', appId.toString(), '--dry-run', '--all'], options(backer))
    expectCliOk(dryRun)
    expect(dryRun.stdout).toContain('Would withdraw pledge #0 (1 ALGO).')
    expect(dryRun.stdout).toContain('Would withdraw pledge #1 (2 ALGO).')
    expect(dryRun.stdout).toContain('Dry run: 2 pledges would be withdrawn.')
    expect(await campaignState(appId, backer.address)).toEqual(snapshot)
    assertAccountDelta('backer', before, await accountInfo(stack.algorand, backer.address), { balance: 0n })

    const empty = await runCli(['withdraw', appId.toString()], options(stranger))
    expectCliOk(empty)
    expect(empty.stdout).toContain(`No live pledges to withdraw from campaign ${appId.toString()}.`)
  })

  test('CLI-023 withdraw guards and the final-day goal protection', { tags: ['bad', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)

    const failedDeadline = (await fetchChainTimestamp()) + DAY + 60n
    const failed = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, { deadline: failedDeadline })
    await pledge(failed.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await advancePastDeadline(fixture, failedDeadline)
    const failedSnapshot = await campaignState(failed.appId, backer.address)
    const failedResult = await runCli(['withdraw', failed.appId.toString()], options(backer))
    expectCliError(failedResult, `Campaign ${failed.appId.toString()} already failed; use \`kasakame refund\` instead`)
    expect(await campaignState(failed.appId, backer.address)).toEqual(failedSnapshot)

    const successfulDeadline = (await fetchChainTimestamp()) + DAY + 120n
    const successful = await createTestCampaign(creator.wallet, MICRO_ALGOS_PER_ALGO, { deadline: successfulDeadline })
    await pledge(successful.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await advancePastDeadline(fixture, successfulDeadline)
    const successfulSnapshot = await campaignState(successful.appId, backer.address)
    const successfulResult = await runCli(['withdraw', successful.appId.toString()], options(backer))
    expectCliError(successfulResult, `Campaign ${successful.appId.toString()} succeeded; its pledges can no longer be withdrawn`)
    expect(await campaignState(successful.appId, backer.address)).toEqual(successfulSnapshot)

    const finalDayDeadline = (await fetchChainTimestamp()) + DAY + 120n
    const finalDay = await createTestCampaign(creator.wallet, 2n * MICRO_ALGOS_PER_ALGO, { deadline: finalDayDeadline })
    await pledge(finalDay.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await pledge(finalDay.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await advanceTo(fixture, finalDayDeadline - 3_600n)
    const finalDaySnapshot = await campaignState(finalDay.appId, backer.address)
    const finalDayResult = await runCli(['withdraw', finalDay.appId.toString(), '--pledge', '0'], options(backer))
    expectCliError(finalDayResult, 'That withdrawal would drop the campaign below its goal in the final day.')
    expect(await campaignState(finalDay.appId, backer.address)).toEqual(finalDaySnapshot)

    const early = await createTestCampaign(creator.wallet, 2n * MICRO_ALGOS_PER_ALGO, {
      deadline: (await fetchChainTimestamp()) + 3n * DAY,
    })
    await pledge(early.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await pledge(early.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const earlyResult = await runCli(['withdraw', early.appId.toString(), '--pledge', '0'], options(backer))
    expectCliOk(earlyResult)
    expect((await leavesOf(early.appId, backer.address)).map((leaf) => leaf.position)).toEqual([1])
    expect((await headerOf(early.appId))?.raisedMicroAlgos).toEqual(MICRO_ALGOS_PER_ALGO)
  })

  test('CLI-024 refund returns every live pledge before delete', { tags: ['smoke', 'happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const deadline = (await fetchChainTimestamp()) + DAY + 60n
    const { appId } = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, { deadline })
    const first = 2n * MICRO_ALGOS_PER_ALGO
    const second = MICRO_ALGOS_PER_ALGO
    await pledge(appId, backer.wallet, first)
    await pledge(appId, backer.wallet, second)
    await advancePastDeadline(fixture, deadline)

    const before = await accountInfo(stack.algorand, backer.address)
    const result = await runCli(['refund', appId.toString(), '--all'], options(backer))
    expectCliOk(result)
    expect(result.stdout).toContain('Refunded pledge #0 (2 ALGO).')
    expect(result.stdout).toContain('Refunded pledge #1 (1 ALGO).')
    expect(result.stdout).toContain('Refunded 2 pledges.')

    const fee = campaignSpendFee(stack.minFee, 2n, 0n) + campaignSpendFee(stack.minFee, 2n, 1n)
    assertAccountDelta('backer', before, await accountInfo(stack.algorand, backer.address), { balance: first + second - fee })
    expect(await leavesOf(appId, backer.address)).toEqual([])
    expect((await headerOf(appId))?.raisedMicroAlgos).toEqual(0n)
    expect((await campaignState(appId, backer.address)).box?.paidOut).toEqual(first + second)
  })

  test('CLI-025 refund selection and dry-run', { tags: ['happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const deadline = (await fetchChainTimestamp()) + DAY + 60n
    const { appId } = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, { deadline })
    const first = MICRO_ALGOS_PER_ALGO
    const second = 2n * MICRO_ALGOS_PER_ALGO
    await pledge(appId, backer.wallet, first)
    await pledge(appId, backer.wallet, second)
    await advancePastDeadline(fixture, deadline)
    const snapshot = await campaignState(appId, backer.address)

    const unselected = await runCli(['refund', appId.toString()], options(backer))
    expectCliError(unselected, `You have 2 live pledges in campaign ${appId.toString()}; pass --pledge <position> or --all`)
    expect(await campaignState(appId, backer.address)).toEqual(snapshot)

    const before = await accountInfo(stack.algorand, backer.address)
    const dryRun = await runCli(['refund', appId.toString(), '--dry-run', '--all'], options(backer))
    expectCliOk(dryRun)
    expect(dryRun.stdout).toContain('Would refund pledge #0 (1 ALGO).')
    expect(dryRun.stdout).toContain('Would refund pledge #1 (2 ALGO).')
    expect(dryRun.stdout).toContain('Dry run: 2 pledges would be refunded.')
    expect(await campaignState(appId, backer.address)).toEqual(snapshot)
    assertAccountDelta('backer', before, await accountInfo(stack.algorand, backer.address), { balance: 0n })

    const selected = await runCli(['refund', appId.toString(), '--pledge', '1'], options(backer))
    expectCliOk(selected)
    expect(selected.stdout).toContain('Refunded pledge #1 (2 ALGO).')
    expect((await leavesOf(appId, backer.address)).map((leaf) => leaf.position)).toEqual([0])

    const rest = await runCli(['refund', appId.toString(), '--all'], options(backer))
    expectCliOk(rest)
    expect(rest.stdout).toContain('Refunded pledge #0 (1 ALGO).')
    expect(await leavesOf(appId, backer.address)).toEqual([])
  })

  test('CLI-026 refund after delete takes the vault route', { tags: ['happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const deadline = (await fetchChainTimestamp()) + DAY + 60n
    const { appId } = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, { deadline })
    const first = 2n * MICRO_ALGOS_PER_ALGO
    const second = MICRO_ALGOS_PER_ALGO
    await pledge(appId, backer.wallet, first)
    await pledge(appId, backer.wallet, second)
    await advancePastDeadline(fixture, deadline)
    await deleteCampaign(appId, creator.wallet)
    await waitForIndexerCatchUp()

    const before = await accountInfo(stack.algorand, backer.address)
    const result = await runCli(['refund', appId.toString(), '--all'], options(backer))
    expectCliOk(result)
    expect(result.stdout).toContain('Refunded 2 pledges.')

    const fee = vaultSpendFee(stack.minFee, 2n, 0n) + vaultSpendFee(stack.minFee, 2n, 1n)
    assertAccountDelta('backer', before, await accountInfo(stack.algorand, backer.address), { balance: first + second - fee })
    expect(await leavesOf(appId, backer.address)).toEqual([])
    expect((await campaignState(appId, backer.address)).box?.paidOut).toEqual(first + second)
  })

  test('CLI-027 refund rejects the wrong status and an empty wallet', { tags: ['bad', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const stranger = await newSigner(fixture)
    const open = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, {
      deadline: (await fetchChainTimestamp()) + TEST_DEADLINE_SECONDS,
    })
    await pledge(open.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const openSnapshot = await campaignState(open.appId, backer.address)

    const openResult = await runCli(['refund', open.appId.toString()], options(backer))
    expectCliError(openResult, `Campaign ${open.appId.toString()} is still open; use \`kasakame withdraw\` before the deadline`)
    expect(await campaignState(open.appId, backer.address)).toEqual(openSnapshot)

    const deadline = (await fetchChainTimestamp()) + DAY + 60n
    const failed = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, { deadline })
    await pledge(failed.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const successful = await createTestCampaign(creator.wallet, MICRO_ALGOS_PER_ALGO, { deadline })
    await pledge(successful.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await advancePastDeadline(fixture, deadline)

    const empty = await runCli(['refund', failed.appId.toString()], options(stranger))
    expectCliOk(empty)
    expect(empty.stdout).toContain(`No live pledges to refund from campaign ${failed.appId.toString()}.`)

    const successfulSnapshot = await campaignState(successful.appId, backer.address)
    const successfulResult = await runCli(['refund', successful.appId.toString()], options(backer))
    expectCliError(successfulResult, `Campaign ${successful.appId.toString()} succeeded; there is nothing to refund`)
    expect(await campaignState(successful.appId, backer.address)).toEqual(successfulSnapshot)
  })
})
