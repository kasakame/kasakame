import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import {
  FEE_MICRO_ALGOS,
  MAX_CAMPAIGN_DURATION_SECONDS,
  MAX_TREE_SIZE,
  MICRO_ALGOS_PER_ALGO,
  MIN_PLEDGE_MICRO_ALGOS,
  MIN_REFUND_WINDOW_SECONDS,
  SECONDS_PER_DAY,
  VAULT_BOX_MBR_MICRO_ALGOS,
  ZERO_ROOT_HEX,
} from '@kasakame/constants'
import { accountInfo, advanceTime, balanceOf, minBalanceOf } from '@kasakame/utils/testing'
import { expect, test } from 'vitest'
import { campaignBox, campaignBoxExists, campaignState, deleteCampaign, deployCampaign, deployStack } from './helpers'
import { FastTree, fastPledge, fastVaultSpend, hex, pathShape, runPledges } from './helpers/fast-pledge'

/**
 * 99 - cap-scale failed campaign (#220, #229): the full 2^19 - 1 tree, then the cap-saturation escape and refund path.
 *
 * Pledges use the fast in-memory helper; the contract still checks every frontier root, so the tree math is verified
 * on-chain at every position. The suite covers the rejected append at the cap, the early `settleOpen` + Registry-backed
 * delete before the deadline, the worst-case vault refund (leaf 0: r = c = 18, 36 path elements), two top-fold
 * refunds, the nulled-sibling and top-only vault refunds, and the residual sweep after the refund window.
 *
 * Runs in the separate `heavy-tests` workflow (~5 h), never in the PR gate.
 */

const GOAL = 60_000n * MICRO_ALGOS_PER_ALGO // above the 52,428.7 ALGO principal
const DEADLINE = MAX_CAMPAIGN_DURATION_SECONDS - SECONDS_PER_DAY // inside the 180-day contract maximum
const TOP_LEAF = 2 ** 18 // first leaf with a higher-peak fold
const MID_LEAF = 3 * 2 ** 17 // mid-range path with a multi-peak top fold
const LAST_LEAF = Number(MAX_TREE_SIZE) - 1 // top-only path

test('CON-240 cap-scale failed campaign settles at the cap', { tags: ['scale'], timeout: 20_000_000 }, async () => {
  // The boundary shapes this suite exists to exercise; checked before spending 5 h on pledges.
  expect(pathShape(Number(MAX_TREE_SIZE), 0)).toEqual({ r: 18, c: 18, hasTop: false })
  expect(pathShape(Number(MAX_TREE_SIZE), TOP_LEAF)).toEqual({ r: 17, c: 17, hasTop: true })
  expect(pathShape(Number(MAX_TREE_SIZE), MID_LEAF)).toEqual({ r: 16, c: 16, hasTop: true })
  expect(pathShape(Number(MAX_TREE_SIZE), LAST_LEAF)).toEqual({ r: 0, c: 0, hasTop: true })

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

  const run = await runPledges(stack, campaign.appClient, campaign.appId, backerAddr, tree, Number(MAX_TREE_SIZE))

  const root = hex(tree.root())
  expect(await campaignState(campaign.appClient)).toEqual({
    n: MAX_TREE_SIZE,
    root,
    raised: run.principal,
    status: 0n,
  })
  expect(await campaignBox(stack.vault.client, campaign.appId)).toMatchObject({
    paidIn: run.principal,
    paidOut: 0n,
    root: ZERO_ROOT_HEX,
    n: 0n,
    status: 1,
  })
  const backerAfterPledges = await accountInfo(stack.algorand, backerAddr)
  expect(backerBefore.balance - backerAfterPledges.balance).toEqual(run.principal + run.fees)
  const vaultAfterPledges = await accountInfo(stack.algorand, stack.vault.address)
  expect(vaultAfterPledges.balance - vaultBefore.balance).toEqual(run.principal)
  expect(vaultAfterPledges.minBalance - vaultBefore.minBalance).toEqual(VAULT_BOX_MBR_MICRO_ALGOS)

  // The cap itself: the next append is rejected by the contract and changes nothing.
  await expect(fastPledge(stack, campaign.appId, backerAddr, MIN_PLEDGE_MICRO_ALGOS, tree)).rejects.toThrow(/campaign reached maximum size/)
  expect((await campaignState(campaign.appClient)).raised).toEqual(run.principal)

  // A full tree that has not reached its goal can never succeed. Settle it early, before the deadline, then delete
  // through the Registry: the cap-saturated campaign is failed-in-fact on both sides.
  console.log('cap reached: settling early')
  await stack.vault.client.send.call({
    method: 'settleOpen(uint64)void',
    args: [campaign.appId],
    sender: creatorAddr,
    appReferences: [campaign.appId],
    suppressLog: true,
  })
  const earlyBox = await campaignBox(stack.vault.client, campaign.appId)
  expect(earlyBox).toMatchObject({
    paidIn: run.principal,
    paidOut: 0n,
    root: hex(tree.root()),
    n: MAX_TREE_SIZE,
    status: 2,
  })
  expect(earlyBox.settledAt).toBeGreaterThan(0n)

  console.log('deleting campaign early through [unregister, delete]')
  await deleteCampaign(stack, campaign.appId, creatorAddr)
  expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(true)

  // Vault refunds after the early settlement. Leaf 0 is the worst case (r = c = 18, 36 path elements); the others
  // cover the top fold, the nulled sibling, and the top-only path.
  let spendFees = 0n
  console.log('refunding leaf 0 (worst case, h=36) through the vault')
  const worst = await fastVaultSpend(stack, campaign.appId, backerAddr, tree, 0, MIN_PLEDGE_MICRO_ALGOS)
  expect(worst.takes).toBeGreaterThan(0)
  console.log(`leaf 0 refunded: ${worst.takes.toString()} takes, ${worst.fee.toString()} uA fee`)
  spendFees += worst.fee

  console.log(`refunding leaf ${TOP_LEAF.toString()} (top fold)`)
  const top = await fastVaultSpend(stack, campaign.appId, backerAddr, tree, TOP_LEAF, MIN_PLEDGE_MICRO_ALGOS)
  expect(top.takes).toBeGreaterThan(0)
  spendFees += top.fee

  console.log(`refunding leaf ${MID_LEAF.toString()} (top fold)`)
  const mid = await fastVaultSpend(stack, campaign.appId, backerAddr, tree, MID_LEAF, MIN_PLEDGE_MICRO_ALGOS)
  expect(mid.takes).toBeGreaterThan(0)
  spendFees += mid.fee

  console.log('vault refund: leaf 1 (nulled sibling)')
  const neighbour = await fastVaultSpend(stack, campaign.appId, backerAddr, tree, 1, MIN_PLEDGE_MICRO_ALGOS)
  expect(neighbour.takes).toBeGreaterThan(0)
  spendFees += neighbour.fee
  console.log('vault refund: top-only leaf')
  const last = await fastVaultSpend(stack, campaign.appId, backerAddr, tree, LAST_LEAF, MIN_PLEDGE_MICRO_ALGOS)
  // The 32-byte path still requests 950 ops, above the remaining base budget, so the prelude always buys one take.
  expect(last.takes).toEqual(1)
  spendFees += last.fee

  expect((await campaignBox(stack.vault.client, campaign.appId)).paidOut).toEqual(5n * MIN_PLEDGE_MICRO_ALGOS)

  // After the refund window, finalize sweeps the residual and releases the box.
  const residual = run.principal - 5n * MIN_PLEDGE_MICRO_ALGOS
  const sweeperBefore = await balanceOf(stack.algorand, stack.sweeperAddress)
  const vaultMinBefore = await minBalanceOf(stack.algorand, stack.vault.address)
  await advanceTime(fixture, MIN_REFUND_WINDOW_SECONDS + 4_000)
  console.log('finalizing the residual')
  await stack.vault.client.send.call({
    method: 'finalize(uint64)void',
    args: [campaign.appId],
    sender: backerAddr,
    extraFee: microAlgos(FEE_MICRO_ALGOS),
    suppressLog: true,
  })
  const finalizeFee = 2n * FEE_MICRO_ALGOS
  expect(await balanceOf(stack.algorand, stack.sweeperAddress)).toEqual(sweeperBefore + residual)
  expect(await minBalanceOf(stack.algorand, stack.vault.address)).toEqual(vaultMinBefore - VAULT_BOX_MBR_MICRO_ALGOS)
  expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)

  // The vault ends where it started; the backer got every refund and paid only the fees.
  expect(await accountInfo(stack.algorand, stack.vault.address)).toEqual(vaultBefore)
  expect((await accountInfo(stack.algorand, backerAddr)).balance).toEqual(
    backerBefore.balance - run.principal - run.fees - spendFees - finalizeFee + 5n * MIN_PLEDGE_MICRO_ALGOS,
  )
})
