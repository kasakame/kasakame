import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { ALGO, accountInfo, advanceTime } from '@kasakame/utils/testing'
import { expect, test } from 'vitest'
import {
  FEE_CLAIM,
  VAULT_BOX_MBR,
  Z_HEX,
  campaignBox,
  campaignBoxExists,
  campaignState,
  claimCampaign,
  deleteCampaign,
  deployCampaign,
  deployStack,
} from '../test/utils'
import { CAP_TREE_SIZE, FastTree, hex, pathShape, runPledges } from '../test/utils/fast-pledge'

/**
 * 99 - cap-scale successful campaign (#220): the full 2^19 - 1 tree, then claim and delete.
 *
 * The claim path is fixed-size (one vault inner call + one payment), so this suite proves the high-popcount pledge
 * path, the vault's paidIn/paidOut accounting at 52,428.7 ALGO, and the MBR return on cleanup.
 *
 * Runs in the separate `heavy-tests` workflow (~5 h), never in the PR gate.
 */

const GOAL = 50_000n * ALGO // below the 52,428.7 ALGO principal
const DEADLINE = 179 * 24 * 60 * 60 // inside the 180-day contract maximum
const LAST_LEAF = CAP_TREE_SIZE - 1 // top-only path

test('CON-241 cap-scale successful campaign claims and deletes', { tags: ['scale'], timeout: 20_000_000 }, async () => {
  expect(pathShape(CAP_TREE_SIZE, LAST_LEAF)).toEqual({ r: 0, c: 0, hasTop: true })

  const fixture = algorandFixture()
  const stack = await deployStack(fixture)
  const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
  const backer = await fixture.context.generateAccount({ initialFunds: (60_000).algo(), suppressLog: true })
  const creatorAddr = creator.addr.toString()
  const backerAddr = backer.addr.toString()
  const campaign = await deployCampaign(stack, creatorAddr, { goal: GOAL, deadlineOffset: DEADLINE })
  const tree = new FastTree()

  const backerBefore = await accountInfo(stack.algorand, backerAddr)
  const vaultBefore = await accountInfo(stack.algorand, stack.vault.address)

  const run = await runPledges(stack, campaign.appClient, campaign.appId, backerAddr, tree, CAP_TREE_SIZE)

  const root = hex(tree.root())
  expect(await campaignState(campaign.appClient)).toEqual({
    n: BigInt(CAP_TREE_SIZE),
    root,
    raised: run.principal,
    status: 0n,
  })
  const box = await campaignBox(stack.vault.client, campaign.appId)
  expect(box).toMatchObject({ paidIn: run.principal, paidOut: 0n, root: Z_HEX, n: 0n, status: 1 })
  expect((await accountInfo(stack.algorand, backerAddr)).balance).toEqual(backerBefore.balance - run.principal - run.fees)

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

  await advanceTime(fixture, 180 * 24 * 60 * 60)

  // The creator claims the full raised principal; the vault pays paidIn - paidOut.
  console.log('deadline passed: claiming')
  const creatorBeforeClaim = await accountInfo(stack.algorand, creatorAddr)
  await claimCampaign(stack, campaign.appClient, campaign.appId, creatorAddr)
  expect((await accountInfo(stack.algorand, creatorAddr)).balance).toEqual(creatorBeforeClaim.balance + run.principal - FEE_CLAIM)
  expect(await campaignBox(stack.vault.client, campaign.appId)).toMatchObject({
    paidIn: run.principal,
    paidOut: run.principal,
    root: Z_HEX,
    n: 0n,
    status: 3,
  })
  const vaultAfterClaim = await accountInfo(stack.algorand, stack.vault.address)
  expect(vaultAfterClaim.balance).toEqual(vaultBefore.balance)
  expect(vaultAfterClaim.minBalance).toEqual(vaultBefore.minBalance + VAULT_BOX_MBR)

  // Cleanup releases the vault box and returns the campaign MBR and registration deposit.
  console.log('deleting campaign')
  await deleteCampaign(stack, campaign.appId, creatorAddr, { vaultBoxRelease: true })
  expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
  expect(await accountInfo(stack.algorand, stack.vault.address)).toEqual(vaultBefore)
  expect((await accountInfo(stack.algorand, backerAddr)).balance).toEqual(backerBefore.balance - run.principal - run.fees)
})
