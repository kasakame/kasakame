import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { expect, test } from 'vitest'
import {
  CAP_AMOUNT,
  CAP_TREE_SIZE,
  FastTree,
  fastPledge,
  fastSpend,
  fastVaultSpend,
  hex,
  pathShape,
  runPledges,
} from './support/fast-pledge'
import {
  ALGO,
  FEE,
  TEST_VAULT_WINDOW,
  VAULT_BOX_MBR,
  accountInfo,
  advanceTime,
  balanceOf,
  campaignBox,
  campaignBoxExists,
  campaignState,
  deleteCampaign,
  deployCampaign,
  deployStack,
  minBalanceOf,
} from './support/localnet'

/**
 * 99 - cap-scale failed campaign (#220): the full 2^19 - 1 tree, then the refund path.
 *
 * Pledges use the fast in-memory helper; the contract still checks every frontier root, so the tree math is verified
 * on-chain at every position. The suite covers the worst-case campaign refund (leaf 0: r = c = 18, 36 path elements,
 * 14 OpUp takes + payBack + payment = 16 inners), two top-fold refunds, the post-delete vault refunds (a nulled
 * sibling and the top-only path), the rejected append at the cap, and the residual sweep after the refund window.
 *
 * Runs in the separate `cap-tests` workflow (~5 h), never in the PR gate.
 */

const GOAL = 60_000n * ALGO // above the 52,428.7 ALGO principal
const DEADLINE = 179 * 24 * 60 * 60 // inside the 180-day contract maximum
const TOP_LEAF = 2 ** 18 // first leaf with a higher-peak fold
const MID_LEAF = 3 * 2 ** 17 // mid-range path with a multi-peak top fold
const LAST_LEAF = CAP_TREE_SIZE - 1 // top-only path

test('CON-240 cap-scale failed campaign refunds the worst-case path', { tags: ['scale'], timeout: 20_000_000 }, async () => {
  // The boundary shapes this suite exists to exercise; checked before spending 5 h on pledges.
  expect(pathShape(CAP_TREE_SIZE, 0)).toEqual({ r: 18, c: 18, hasTop: false })
  expect(pathShape(CAP_TREE_SIZE, TOP_LEAF)).toEqual({ r: 17, c: 17, hasTop: true })
  expect(pathShape(CAP_TREE_SIZE, MID_LEAF)).toEqual({ r: 16, c: 16, hasTop: true })
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
  expect(await campaignBox(stack.vault.client, campaign.appId)).toMatchObject({
    paidIn: run.principal,
    paidOut: 0n,
    root,
    n: BigInt(CAP_TREE_SIZE),
    status: 1,
  })
  const backerAfterPledges = await accountInfo(stack.algorand, backerAddr)
  expect(backerBefore.balance - backerAfterPledges.balance).toEqual(run.principal + run.fees)
  const vaultAfterPledges = await accountInfo(stack.algorand, stack.vault.address)
  expect(vaultAfterPledges.balance - vaultBefore.balance).toEqual(run.principal)
  expect(vaultAfterPledges.minBalance - vaultBefore.minBalance).toEqual(VAULT_BOX_MBR)

  // The cap itself: the next append is rejected by the contract and changes nothing.
  await expect(fastPledge(stack, campaign.appId, backerAddr, CAP_AMOUNT, tree)).rejects.toThrow(/campaign reached maximum size/)
  expect((await campaignState(campaign.appClient)).raised).toEqual(run.principal)

  await advanceTime(fixture, 180 * 24 * 60 * 60)

  // Worst case: r = c = 18 -> 14 OpUp takes plus payBack and payment = 16 inner transactions.
  let spendFees = 0n
  const worst = await fastSpend(stack, campaign.appId, backerAddr, 'refund(uint64,uint64,byte[],byte[])void', tree, 0, CAP_AMOUNT)
  expect(worst.takes).toEqual(14)
  expect(worst.fee).toEqual(18_000n)
  spendFees += worst.fee
  expect(await campaignState(campaign.appClient)).toEqual({
    n: BigInt(CAP_TREE_SIZE),
    root: hex(tree.root()),
    raised: run.principal - CAP_AMOUNT,
    status: 1n,
  })
  expect((await campaignBox(stack.vault.client, campaign.appId)).paidOut).toEqual(CAP_AMOUNT)

  // Top fold: 17 siblings + top + 17 lower peaks.
  const top = await fastSpend(stack, campaign.appId, backerAddr, 'refund(uint64,uint64,byte[],byte[])void', tree, TOP_LEAF, CAP_AMOUNT)
  expect(top.takes).toBeGreaterThan(0)
  spendFees += top.fee

  // Mid-range shape: the top fold now includes the nulled leaf 0 and TOP_LEAF blocks.
  const mid = await fastSpend(stack, campaign.appId, backerAddr, 'refund(uint64,uint64,byte[],byte[])void', tree, MID_LEAF, CAP_AMOUNT)
  expect(mid.takes).toBeGreaterThan(0)
  spendFees += mid.fee

  // Deletion settles the root and keeps the box for post-delete vault refunds.
  await deleteCampaign(stack, campaign.appId, creatorAddr)
  const settled = await campaignBox(stack.vault.client, campaign.appId)
  expect(settled).toMatchObject({
    paidIn: run.principal,
    paidOut: 3n * CAP_AMOUNT,
    root: hex(tree.root()),
    n: BigInt(CAP_TREE_SIZE),
    status: 2,
  })
  expect(settled.settledAt).toBeGreaterThan(0n)

  // Vault refunds after deletion: a nulled sibling (leaf 0 is zero) and the top-only path.
  const neighbour = await fastVaultSpend(stack, campaign.appId, backerAddr, tree, 1, CAP_AMOUNT)
  expect(neighbour.takes).toBeGreaterThan(0)
  spendFees += neighbour.fee
  const last = await fastVaultSpend(stack, campaign.appId, backerAddr, tree, LAST_LEAF, CAP_AMOUNT)
  // The 32-byte path still requests 950 ops, above the remaining base budget, so the prelude always buys one take.
  expect(last.takes).toEqual(1)
  spendFees += last.fee

  expect((await campaignBox(stack.vault.client, campaign.appId)).paidOut).toEqual(5n * CAP_AMOUNT)

  // After the refund window, finalize sweeps the residual and releases the box.
  const residual = run.principal - 5n * CAP_AMOUNT
  const sweeperBefore = await balanceOf(stack.algorand, stack.sweeperAddress)
  const vaultMinBefore = await minBalanceOf(stack.algorand, stack.vault.address)
  await advanceTime(fixture, Number(TEST_VAULT_WINDOW) + 4_000)
  await stack.vault.client.send.call({
    method: 'finalize(uint64)void',
    args: [campaign.appId],
    sender: backerAddr,
    extraFee: microAlgos(FEE),
    suppressLog: true,
  })
  const finalizeFee = 2n * FEE
  expect(await balanceOf(stack.algorand, stack.sweeperAddress)).toEqual(sweeperBefore + residual)
  expect(await minBalanceOf(stack.algorand, stack.vault.address)).toEqual(vaultMinBefore - VAULT_BOX_MBR)
  expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)

  // The vault ends where it started; the backer got every refund and paid only the fees.
  expect(await accountInfo(stack.algorand, stack.vault.address)).toEqual(vaultBefore)
  expect((await accountInfo(stack.algorand, backerAddr)).balance).toEqual(
    backerBefore.balance - run.principal - run.fees - spendFees - finalizeFee + 5n * CAP_AMOUNT,
  )
})
