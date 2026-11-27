import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import {
  CAMPAIGN_STATUS_OPEN,
  CLAIM_FEE_MICRO_ALGOS,
  MAX_CAMPAIGN_DURATION_SECONDS,
  MAX_TREE_SIZE,
  MICRO_ALGOS_PER_ALGO,
  SECONDS_PER_DAY,
  VAULT_BOX_MBR_MICRO_ALGOS,
  VAULT_BOX_STATUS_CLAIMED_HEX,
  VAULT_BOX_STATUS_OPEN_HEX,
  ZERO_ROOT_HEX,
} from '@kasakame/constants'
import { advanceTime } from '@kasakame/utils/testing'
import { expect, test } from 'vitest'
import {
  actorSnapshot,
  campaignBox,
  campaignBoxExists,
  campaignState,
  claimCampaign,
  deleteCampaign,
  deployCampaign,
  deployStack,
  expectActorDeltas,
} from './utils'
import { FastTree, hex, pathShape, runPledges } from './utils/fast-pledge'

/**
 * 99 - cap-scale successful campaign (#220): fill the full 2^19 - 1 tree, then claim and delete (heavy-tests only).
 */

const GOAL = 50_000n * MICRO_ALGOS_PER_ALGO // below the 52,428.7 ALGO principal
const DEADLINE = MAX_CAMPAIGN_DURATION_SECONDS - SECONDS_PER_DAY // inside the 180-day contract maximum
const LAST_LEAF = Number(MAX_TREE_SIZE) - 1 // top-only path
const BOX_OPEN = Number.parseInt(VAULT_BOX_STATUS_OPEN_HEX, 16)
const BOX_CLAIMED = Number.parseInt(VAULT_BOX_STATUS_CLAIMED_HEX, 16)

test('CON-241 cap-scale successful campaign claims and deletes', { tags: ['scale'], timeout: 20_000_000 }, async () => {
  expect(pathShape(Number(MAX_TREE_SIZE), LAST_LEAF)).toEqual({ r: 0, c: 0, hasTop: true })

  const fixture = algorandFixture()
  const stack = await deployStack(fixture)
  const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
  const backer = await fixture.context.generateAccount({ initialFunds: (60_000).algo(), suppressLog: true })
  const creatorAddr = creator.addr.toString()
  const backerAddr = backer.addr.toString()
  const campaign = await deployCampaign(stack, creatorAddr, { goal: GOAL, deadlineOffset: DEADLINE })
  const tree = new FastTree()

  const backerBefore = await actorSnapshot(stack.algorand, [backerAddr])
  const vaultBefore = await actorSnapshot(stack.algorand, [stack.vault.address])

  const run = await runPledges(stack, campaign.appClient, campaign.appId, backerAddr, tree, Number(MAX_TREE_SIZE))

  const root = hex(tree.root())
  expect(await campaignState(campaign.appClient)).toEqual({
    n: MAX_TREE_SIZE,
    root,
    raised: run.principal,
    status: CAMPAIGN_STATUS_OPEN,
  })
  const box = await campaignBox(stack.vault.client, campaign.appId)
  expect(box).toMatchObject({ paidIn: run.principal, paidOut: 0n, root: ZERO_ROOT_HEX, n: 0n, status: BOX_OPEN })
  expectActorDeltas(backerBefore, await actorSnapshot(stack.algorand, [backerAddr]), {
    [backerAddr]: { balance: -run.principal - run.fees },
  })

  // The cap is full but the goal was reached, so the early escape must not settle a campaign that can still succeed.
  await expect(
    stack.vault.client.send.call({
      method: 'settleOpen(uint64)void',
      args: [campaign.appId],
      sender: creatorAddr,
      appReferences: [campaign.appId],
      suppressLog: true,
    }),
  ).rejects.toThrow(/goal was reached/)

  await advanceTime(fixture, MAX_CAMPAIGN_DURATION_SECONDS)

  // The creator claims the full raised principal; the vault pays paidIn - paidOut.
  console.log('deadline passed: claiming')
  const creatorBeforeClaim = await actorSnapshot(stack.algorand, [creatorAddr])
  await claimCampaign(stack, campaign.appClient, campaign.appId, creatorAddr)
  expectActorDeltas(creatorBeforeClaim, await actorSnapshot(stack.algorand, [creatorAddr]), {
    [creatorAddr]: { balance: run.principal - CLAIM_FEE_MICRO_ALGOS },
  })
  expect(await campaignBox(stack.vault.client, campaign.appId)).toMatchObject({
    paidIn: run.principal,
    paidOut: run.principal,
    root: ZERO_ROOT_HEX,
    n: 0n,
    status: BOX_CLAIMED,
  })
  expectActorDeltas(vaultBefore, await actorSnapshot(stack.algorand, [stack.vault.address]), {
    [stack.vault.address]: { balance: 0n, minBalance: VAULT_BOX_MBR_MICRO_ALGOS },
  })

  // Cleanup releases the vault box and returns the campaign MBR and registration deposit.
  console.log('deleting campaign')
  await deleteCampaign(stack, campaign.appId, creatorAddr, { vaultBoxRelease: true })
  expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
  expectActorDeltas(vaultBefore, await actorSnapshot(stack.algorand, [stack.vault.address]), {
    [stack.vault.address]: { balance: 0n, minBalance: 0n },
  })
  expectActorDeltas(backerBefore, await actorSnapshot(stack.algorand, [backerAddr]), {
    [backerAddr]: { balance: -run.principal - run.fees },
  })
})
