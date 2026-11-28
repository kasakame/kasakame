import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { MICRO_ALGOS_PER_ALGO, SECONDS_PER_DAY } from '@kasakame/constants'
import { deleteCampaign, fetchChainTimestamp, pledge, waitForIndexerCatchUp } from '@kasakame/sdk'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  advancePastDeadline,
  createTestCampaign,
  expectCliOk,
  newSigner,
  runCli,
  setupCliStack,
  type CliSigner,
  type CliStack,
} from './utils/index.js'

describe('CLI reads (localnet)', () => {
  const fixture = algorandFixture()
  let stack: CliStack
  let creator: CliSigner
  let backer: CliSigner
  let stranger: CliSigner
  let openId: bigint
  let pristineId: bigint
  let deletedId: bigint
  let successfulId: bigint

  const longDeadline = 10n * BigInt(SECONDS_PER_DAY)
  const shortDeadline = BigInt(SECONDS_PER_DAY) + 120n

  beforeAll(async () => {
    stack = await setupCliStack(fixture)
    creator = await newSigner(fixture)
    backer = await newSigner(fixture)
    stranger = await newSigner(fixture)
    const now = await fetchChainTimestamp()

    openId = (
      await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, {
        deadline: now + longDeadline,
        title: 'CLI open campaign',
      })
    ).appId
    await pledge(openId, backer.wallet, 2n * MICRO_ALGOS_PER_ALGO)
    await pledge(openId, backer.wallet, MICRO_ALGOS_PER_ALGO)

    pristineId = (
      await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, {
        deadline: now + longDeadline,
        title: 'CLI pristine campaign',
      })
    ).appId

    deletedId = (
      await createTestCampaign(creator.wallet, 10n * MICRO_ALGOS_PER_ALGO, {
        deadline: now + shortDeadline,
        title: 'CLI deleted campaign',
      })
    ).appId
    await pledge(deletedId, backer.wallet, 2n * MICRO_ALGOS_PER_ALGO)

    successfulId = (
      await createTestCampaign(creator.wallet, MICRO_ALGOS_PER_ALGO, {
        deadline: now + shortDeadline,
        title: 'CLI successful campaign',
      })
    ).appId
    await pledge(successfulId, backer.wallet, MICRO_ALGOS_PER_ALGO)

    await advancePastDeadline(fixture, now + shortDeadline)
    await deleteCampaign(deletedId, creator.wallet)
    await waitForIndexerCatchUp()
  })

  test('CLI-010 pledges lists the live leaves and their actions', { tags: ['smoke', 'happy', 'always'] }, async () => {
    const result = await runCli(['pledges'], {
      mnemonic: backer.mnemonic,
      vaultAppId: stack.vaultAppId,
      registryAppId: stack.registryAppId,
    })
    expectCliOk(result)
    expect(result.stdout).toContain(`Live pledges by ${backer.address} on localnet:`)
    expect(result.stdout).toContain('app id')
    expect(result.stdout).toContain('pledge')
    expect(result.stdout).toContain('amount')
    expect(result.stdout).toContain('action')
    expect(result.stdout).toContain(openId.toString())
    expect(result.stdout).toContain('CLI open campaign')
    expect(result.stdout).toContain('withdraw --pledge 0')
    expect(result.stdout).toContain('withdraw --pledge 1')
    expect(result.stdout).toContain(deletedId.toString())
    expect(result.stdout).toContain('failed, deleted')
    expect(result.stdout).toContain('refund')
    expect(result.stdout).toContain('Use --all to act on every pledge.')
    expect(result.stdout).not.toContain('Read-only view')
    expect(result.stderr).toContain(`Searching localnet for live pledges by ${backer.address}…`)
  })

  test('CLI-011 pledges --address is a read-only table', { tags: ['happy', 'always'] }, async () => {
    const result = await runCli(['pledges', '--address', backer.address], {
      vaultAppId: stack.vaultAppId,
      registryAppId: stack.registryAppId,
    })
    expectCliOk(result)
    expect(result.stdout).toContain(`Live pledges by ${backer.address} on localnet:`)
    expect(result.stdout).toContain("Read-only view; withdraw and refund need the pledge owner's wallet.")
    expect(result.stdout).toContain(openId.toString())
    expect(result.stdout).not.toContain('withdraw --pledge')
    expect(result.stdout).not.toContain('Use --all')
  })

  test('CLI-012 pledges with no leaves prints the empty message', { tags: ['happy', 'always'] }, async () => {
    const result = await runCli(['pledges'], {
      mnemonic: stranger.mnemonic,
      vaultAppId: stack.vaultAppId,
      registryAppId: stack.registryAppId,
    })
    expectCliOk(result)
    expect(result.stdout).toContain(`No live pledges by ${stranger.address} on localnet.`)
  })

  test('CLI-013 campaigns lists each creator action', { tags: ['smoke', 'happy', 'always'] }, async () => {
    const result = await runCli(['campaigns'], {
      mnemonic: creator.mnemonic,
      vaultAppId: stack.vaultAppId,
      registryAppId: stack.registryAppId,
    })
    expectCliOk(result)
    expect(result.stdout).toContain(`Campaigns created by ${creator.address} on localnet:`)
    expect(result.stdout).toContain('raised / goal')
    expect(result.stdout).toContain('action')
    expect(result.stdout).toMatch(new RegExp(`^${openId.toString()}\\s+CLI open campaign\\s+open\\s+3 / 10 ALGO\\s+.*\\s+-$`, 'm'))
    expect(result.stdout).toMatch(
      new RegExp(`^${pristineId.toString()}\\s+CLI pristine campaign\\s+open\\s+0 / 10 ALGO\\s+.*\\s+delete$`, 'm'),
    )
    expect(result.stdout).toMatch(
      new RegExp(`^${successfulId.toString()}\\s+CLI successful campaign\\s+successful\\s+1 / 1 ALGO\\s+.*\\s+claim$`, 'm'),
    )
    expect(result.stdout).toMatch(
      new RegExp(`^${deletedId.toString()}\\s+CLI deleted campaign\\s+failed, deleted\\s+2 / 10 ALGO\\s+.*\\s+-$`, 'm'),
    )
  })

  test('CLI-014 campaigns --address is a read-only table', { tags: ['happy', 'always'] }, async () => {
    const result = await runCli(['campaigns', '--address', creator.address], {
      vaultAppId: stack.vaultAppId,
      registryAppId: stack.registryAppId,
    })
    expectCliOk(result)
    expect(result.stdout).toContain("Read-only view; claim and delete need the creator's wallet.")
    expect(result.stdout).toContain(successfulId.toString())
    expect(result.stdout).not.toMatch(/successful\s+claim/)
  })

  test('CLI-015 campaigns with no matches prints the empty message', { tags: ['happy', 'always'] }, async () => {
    const result = await runCli(['campaigns'], {
      mnemonic: stranger.mnemonic,
      vaultAppId: stack.vaultAppId,
      registryAppId: stack.registryAppId,
    })
    expectCliOk(result)
    expect(result.stdout).toContain(`No campaigns created by ${stranger.address} on localnet.`)
  })

  test('CLI-016 a deleted campaign stays readable', { tags: ['happy', 'always'] }, async () => {
    const pledges = await runCli(['pledges'], {
      mnemonic: backer.mnemonic,
      vaultAppId: stack.vaultAppId,
      registryAppId: stack.registryAppId,
    })
    expectCliOk(pledges)
    expect(pledges.stdout).toMatch(new RegExp(`^${deletedId.toString()}\\s+CLI deleted campaign\\s+failed, deleted\\s+.*\\s+refund$`, 'm'))

    const campaigns = await runCli(['campaigns'], {
      mnemonic: creator.mnemonic,
      vaultAppId: stack.vaultAppId,
      registryAppId: stack.registryAppId,
    })
    expectCliOk(campaigns)
    expect(campaigns.stdout).toMatch(
      new RegExp(`^${deletedId.toString()}\\s+CLI deleted campaign\\s+failed, deleted\\s+2 / 10 ALGO\\s+.*\\s+-$`, 'm'),
    )
  })

  test('CLI-017 discovery falls back to vault boxes without --registry', { tags: ['happy', 'always'] }, async () => {
    const pledges = await runCli(['pledges'], { mnemonic: backer.mnemonic, vaultAppId: stack.vaultAppId })
    expectCliOk(pledges)
    expect(pledges.stdout).toContain(openId.toString())
    expect(pledges.stdout).toContain(deletedId.toString())
    expect(pledges.stdout).toContain('failed, deleted')

    const campaigns = await runCli(['campaigns'], { mnemonic: creator.mnemonic, vaultAppId: stack.vaultAppId })
    expectCliOk(campaigns)
    expect(campaigns.stdout).toContain(openId.toString())
    expect(campaigns.stdout).not.toContain(pristineId.toString())
  })
})
