import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO, REGISTER_DEPOSIT_MICRO_ALGOS, SECONDS_PER_DAY, VAULT_BOX_MBR_MICRO_ALGOS } from '@kasakame/constants'
import { claim, deleteCampaign, fetchChainTimestamp, isRegistered, pledge, waitForIndexerCatchUp } from '@kasakame/sdk'
import { accountInfo, assertAccountDelta } from '@kasakame/utils/testing'
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
  type TestCampaignOptions,
} from './utils/index.js'

describe('CLI creator flows (localnet)', () => {
  const fixture = algorandFixture()
  let stack: CliStack
  const DAY = BigInt(SECONDS_PER_DAY)

  beforeAll(async () => {
    stack = await setupCliStack(fixture)
  })

  function options(signer: CliSigner) {
    return { mnemonic: signer.mnemonic, vaultAppId: stack.vaultAppId, registryAppId: stack.registryAppId }
  }

  async function createWithMbr(creator: CliSigner, goal: bigint, campaignOptions: TestCampaignOptions = {}) {
    const before = await accountInfo(stack.algorand, creator.address)
    const result = await createTestCampaign(creator.wallet, goal, campaignOptions)
    const after = await accountInfo(stack.algorand, creator.address)
    return { ...result, campaignMbr: after.minBalance - before.minBalance }
  }

  test('CLI-030 claim pays the live total to the creator', { tags: ['smoke', 'happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const deadline = (await fetchChainTimestamp()) + DAY + 60n
    const { appId } = await createTestCampaign(creator.wallet, MICRO_ALGOS_PER_ALGO, { deadline })
    await pledge(appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await advancePastDeadline(fixture, deadline)

    const before = await accountInfo(stack.algorand, creator.address)
    const result = await runCli(['claim', appId.toString()], options(creator))
    expectCliOk(result)
    expect(result.stdout).toContain(`Claimed campaign ${appId.toString()}; the vault paid its live total to ${creator.address}.`)
    expect(result.stdout).toContain('Confirmed in round')
    expect(result.stdout).toContain('Explorer: https://lora.algokit.io/localnet/tx/')

    const after = await accountInfo(stack.algorand, creator.address)
    assertAccountDelta('creator', before, after, { balance: MICRO_ALGOS_PER_ALGO - 3n * stack.minFee })
    expect((await headerOf(appId))?.status).toEqual('claimed')
    expect((await campaignState(appId, backer.address)).box).toMatchObject({
      status: 3,
      paidIn: MICRO_ALGOS_PER_ALGO,
      paidOut: MICRO_ALGOS_PER_ALGO,
    })
  })

  test('CLI-031 claim dry-run and guards', { tags: ['bad', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const stranger = await newSigner(fixture)

    const open = await createTestCampaign(creator.wallet, MICRO_ALGOS_PER_ALGO, {
      deadline: (await fetchChainTimestamp()) + TEST_DEADLINE_SECONDS,
    })
    await pledge(open.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const openSnapshot = await campaignState(open.appId, creator.address)
    const openResult = await runCli(['claim', open.appId.toString()], options(creator))
    expectCliError(openResult, `Campaign ${open.appId.toString()} is still open; claim opens after its deadline`)
    expect(await campaignState(open.appId, creator.address)).toEqual(openSnapshot)

    const deadline = (await fetchChainTimestamp()) + DAY + 60n
    const successful = await createTestCampaign(creator.wallet, MICRO_ALGOS_PER_ALGO, { deadline })
    await pledge(successful.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const failed = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, { deadline })
    await pledge(failed.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await advancePastDeadline(fixture, deadline)

    const successfulSnapshot = await campaignState(successful.appId, creator.address)
    const failedSnapshot = await campaignState(failed.appId, creator.address)
    const before = await accountInfo(stack.algorand, creator.address)

    const dryRun = await runCli(['claim', successful.appId.toString(), '--dry-run'], options(creator))
    expectCliOk(dryRun)
    expect(dryRun.stdout).toContain(`Would claim campaign ${successful.appId.toString()} as ${creator.address}.`)
    expect(dryRun.stdout).toContain('Dry run: nothing submitted.')
    expect(await campaignState(successful.appId, creator.address)).toEqual(successfulSnapshot)

    const failedResult = await runCli(['claim', failed.appId.toString()], options(creator))
    expectCliError(failedResult, `Campaign ${failed.appId.toString()} failed; there is nothing to claim`)
    expect(await campaignState(failed.appId, creator.address)).toEqual(failedSnapshot)

    const strangerResult = await runCli(['claim', successful.appId.toString()], options(stranger))
    expectCliError(strangerResult, `Campaign ${successful.appId.toString()} was created by ${creator.address}; only the creator can claim`)
    expect(await campaignState(successful.appId, creator.address)).toEqual(successfulSnapshot)
    assertAccountDelta('creator', before, await accountInfo(stack.algorand, creator.address), { balance: 0n })

    await claim(successful.appId, creator.wallet)
    const again = await runCli(['claim', successful.appId.toString()], options(creator))
    expectCliError(again, `Campaign ${successful.appId.toString()} was already claimed`)
  })

  test('CLI-032 delete a pristine campaign returns the deposit', { tags: ['happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)

    const registered = await createWithMbr(creator, 10n * MICRO_ALGOS_PER_ALGO)
    const registeredBefore = await accountInfo(stack.algorand, creator.address)
    const registeredResult = await runCli(['delete', registered.appId.toString()], options(creator))
    expectCliOk(registeredResult)
    expect(registeredResult.stdout).toContain(`Deleted campaign ${registered.appId.toString()}.`)
    expect(registeredResult.stdout).not.toContain('Backers keep refunding')
    expect(registeredResult.stdout).toContain("The campaign's schema MBR and any Registry registration deposit are back in your account.")
    const registeredAfter = await accountInfo(stack.algorand, creator.address)
    assertAccountDelta('creator', registeredBefore, registeredAfter, {
      balance: REGISTER_DEPOSIT_MICRO_ALGOS - 5n * stack.minFee,
      minBalance: -registered.campaignMbr,
    })
    expect(await isRegistered(registered.appId)).toBe(false)
    await expect(stack.algorand.app.getById(registered.appId)).rejects.toThrow()
  })

  test('CLI-033 delete a claimed campaign and a failed campaign', { tags: ['happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const deadline = (await fetchChainTimestamp()) + DAY + 60n
    const claimed = await createWithMbr(creator, MICRO_ALGOS_PER_ALGO, { deadline })
    await pledge(claimed.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const failed = await createWithMbr(creator, 10n * MICRO_ALGOS_PER_ALGO, { deadline })
    await pledge(failed.appId, backer.wallet, 2n * MICRO_ALGOS_PER_ALGO)
    await advancePastDeadline(fixture, deadline)
    await claim(claimed.appId, creator.wallet)
    await waitForIndexerCatchUp()

    const vaultBefore = await accountInfo(stack.algorand, stack.vaultAddress)
    const claimedBefore = await accountInfo(stack.algorand, creator.address)
    const claimedResult = await runCli(['delete', claimed.appId.toString()], options(creator))
    expectCliOk(claimedResult)
    expect(claimedResult.stdout).not.toContain('Backers keep refunding')
    assertAccountDelta('creator', claimedBefore, await accountInfo(stack.algorand, creator.address), {
      balance: REGISTER_DEPOSIT_MICRO_ALGOS - 5n * stack.minFee,
      minBalance: -claimed.campaignMbr,
    })
    expect(await isRegistered(claimed.appId)).toBe(false)
    expect(await stack.algorand.app.getById(claimed.appId).catch(() => undefined)).toBeUndefined()
    expect((await campaignState(claimed.appId, backer.address)).box).toBeUndefined()
    assertAccountDelta('vault', vaultBefore, await accountInfo(stack.algorand, stack.vaultAddress), {
      minBalance: -VAULT_BOX_MBR_MICRO_ALGOS,
    })

    const failedBefore = await accountInfo(stack.algorand, creator.address)
    const failedResult = await runCli(['delete', failed.appId.toString()], options(creator))
    expectCliOk(failedResult)
    expect(failedResult.stdout).toContain('Backers keep refunding from the vault until the refund window closes.')
    assertAccountDelta('creator', failedBefore, await accountInfo(stack.algorand, creator.address), {
      balance: REGISTER_DEPOSIT_MICRO_ALGOS - 5n * stack.minFee,
      minBalance: -failed.campaignMbr,
    })
    expect((await campaignState(failed.appId, backer.address)).box).toMatchObject({ status: 2, paidIn: 2n * MICRO_ALGOS_PER_ALGO })
  })

  test('CLI-034 delete rejects the wrong state and wallet', { tags: ['bad', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)

    const live = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, {
      deadline: (await fetchChainTimestamp()) + TEST_DEADLINE_SECONDS,
    })
    await pledge(live.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const liveSnapshot = await campaignState(live.appId, creator.address)
    const liveResult = await runCli(['delete', live.appId.toString()], options(creator))
    expectCliError(liveResult, `Campaign ${live.appId.toString()} is still open with live pledges; cancel them or wait for the deadline`)
    expect(await campaignState(live.appId, creator.address)).toEqual(liveSnapshot)

    const deadline = (await fetchChainTimestamp()) + DAY + 60n
    const successful = await createTestCampaign(creator.wallet, MICRO_ALGOS_PER_ALGO, { deadline })
    await pledge(successful.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    await advancePastDeadline(fixture, deadline)
    const successfulSnapshot = await campaignState(successful.appId, creator.address)
    const successfulResult = await runCli(['delete', successful.appId.toString()], options(creator))
    expectCliError(successfulResult, `Campaign ${successful.appId.toString()} reached its goal; claim it before deleting`)
    expect(await campaignState(successful.appId, creator.address)).toEqual(successfulSnapshot)

    const pristine = await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO)
    const strangerResult = await runCli(['delete', pristine.appId.toString()], options(backer))
    expectCliError(
      strangerResult,
      `Campaign ${pristine.appId.toString()} was created by ${creator.address}; only the creator can delete it`,
    )
    expect(await headerOf(pristine.appId)).toBeDefined()

    await deleteCampaign(pristine.appId, creator.wallet)
    const deletedResult = await runCli(['delete', pristine.appId.toString()], options(creator))
    expectCliError(deletedResult, `Campaign ${pristine.appId.toString()} was already deleted`)
  })

  test('CLI-035 delete dry-run and a withdrawn-to-zero campaign', { tags: ['happy', 'always'] }, async () => {
    const creator = await newSigner(fixture)
    const backer = await newSigner(fixture)
    const pristine = await createWithMbr(creator, 10n * MICRO_ALGOS_PER_ALGO)

    const dryRun = await runCli(['delete', pristine.appId.toString(), '--dry-run'], options(creator))
    expectCliOk(dryRun)
    expect(dryRun.stdout).toContain(`Would delete campaign ${pristine.appId.toString()} as ${creator.address}.`)
    expect(dryRun.stdout).toContain('Dry run: nothing submitted.')
    expect(await headerOf(pristine.appId)).toBeDefined()

    const withdrawn = await createWithMbr(creator, 10n * MICRO_ALGOS_PER_ALGO)
    await pledge(withdrawn.appId, backer.wallet, MICRO_ALGOS_PER_ALGO)
    const withdrawResult = await runCli(['withdraw', withdrawn.appId.toString()], options(backer))
    expectCliOk(withdrawResult)
    expect(await leavesOf(withdrawn.appId, backer.address)).toEqual([])

    const before = await accountInfo(stack.algorand, creator.address)
    const deleteResult = await runCli(['delete', withdrawn.appId.toString()], options(creator))
    expectCliOk(deleteResult)
    assertAccountDelta('creator', before, await accountInfo(stack.algorand, creator.address), {
      balance: REGISTER_DEPOSIT_MICRO_ALGOS - 5n * stack.minFee,
      minBalance: -withdrawn.campaignMbr,
    })
    await expect(stack.algorand.app.getById(withdrawn.appId)).rejects.toThrow()
  })
})
