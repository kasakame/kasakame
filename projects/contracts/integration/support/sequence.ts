import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import type { Account } from 'algosdk'
import { expect } from 'vitest'
import {
  ALGO,
  ClaimTreeOracle,
  FEE,
  VAULT_BOX_MBR,
  advanceTime,
  balanceOf,
  campaignBoxExists,
  deleteCampaign,
  deployCampaign,
  minBalanceOf,
  pledge,
  spendCampaign,
  spendVault,
  type ContractStack,
} from './localnet'
import { seededRandom } from './random'
import { describeScale, type ScaleConfig } from './scale'

const SEQUENCE_BACKERS = 5
const CANCEL_CHANCE = 0.25
const CAMPAIGN_REFUND_DIVISOR = 10
const VAULT_REFUND_DIVISOR = 20
const VAULT_WINDOW_ADVANCE = 4_000

interface Leaf {
  backer: Account
  txid: string
  spent: boolean
}

function at<T>(items: T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`missing item at index ${index.toString()}`)
  return item
}

function pickUnspent(random: () => number, leaves: Leaf[]): number | undefined {
  const candidates: number[] = []
  for (let i = 0; i < leaves.length; i++) {
    if (!at(leaves, i).spent) candidates.push(i)
  }
  if (candidates.length === 0) return undefined
  return at(candidates, Math.floor(random() * candidates.length))
}

function needsBoost(config: ScaleConfig): boolean {
  return config.maxN > 255
}

/**
 * Run one reproducible pledge/cancel/refund/finalize sequence against a fresh campaign.
 *
 * The shared pledge/spend helpers already assert the oracle root/N/raised and the vault box after every step; this
 * wrapper only chooses the actions and adds the seed and ordered action list to a failure.
 *
 * @param fixture The LocalNet fixture.
 * @param stack The deployed platform stack.
 * @param config The active scale config.
 * @param seed The PRNG seed.
 */
export async function runSequence(fixture: AlgorandFixture, stack: ContractStack, config: ScaleConfig, seed: number): Promise<void> {
  const random = seededRandom(seed)
  const actions: string[] = []
  const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
  const backers: Account[] = []
  for (let i = 0; i < SEQUENCE_BACKERS; i++) {
    backers.push(await fixture.context.generateAccount({ initialFunds: (300).algo(), suppressLog: true }))
  }
  const campaign = await deployCampaign(stack, creator.addr.toString(), { goal: BigInt(config.maxN + 1) * ALGO })
  const oracle = new ClaimTreeOracle(`sequence-${seed.toString()}-`)
  const leaves: Leaf[] = []
  try {
    for (let i = 0; i < config.maxN; i++) {
      if (leaves.length > 0 && random() < CANCEL_CHANCE) {
        const index = pickUnspent(random, leaves)
        if (index !== undefined) {
          const leaf = at(leaves, index)
          actions.push(`cancel:${index.toString()}`)
          await spendCampaign(
            stack,
            campaign.appClient,
            campaign.appId,
            leaf.backer.addr.toString(),
            index,
            1n * ALGO,
            leaf.txid,
            'cancelPledge(uint64,uint64,byte[],byte[])void',
            oracle,
            { budgetBooster: needsBoost(config) },
          )
          leaf.spent = true
        }
      }
      const backer = at(backers, i % backers.length)
      const txid = await pledge(stack, campaign.appClient, campaign.appId, backer.addr.toString(), 1n * ALGO, oracle)
      leaves.push({ backer, txid, spent: false })
      actions.push(`pledge:${i.toString()}:backer=${(i % backers.length).toString()}`)
    }

    await advanceTime(fixture, 900)
    const campaignRefunds = Math.max(1, Math.floor(config.maxN / CAMPAIGN_REFUND_DIVISOR))
    for (let i = 0; i < campaignRefunds; i++) {
      const index = pickUnspent(random, leaves)
      if (index === undefined) break
      const leaf = at(leaves, index)
      actions.push(`refund:${index.toString()}`)
      await spendCampaign(
        stack,
        campaign.appClient,
        campaign.appId,
        leaf.backer.addr.toString(),
        index,
        1n * ALGO,
        leaf.txid,
        'refund(uint64,uint64,byte[],byte[])void',
        oracle,
        { budgetBooster: needsBoost(config) },
      )
      leaf.spent = true
    }

    await deleteCampaign(stack, campaign.appId, creator.addr.toString())
    const vaultRefunds = Math.max(1, Math.floor(config.maxN / VAULT_REFUND_DIVISOR))
    for (let i = 0; i < vaultRefunds; i++) {
      const index = pickUnspent(random, leaves)
      if (index === undefined) break
      const leaf = at(leaves, index)
      actions.push(`vault-refund:${index.toString()}`)
      await spendVault(stack, campaign.appId, leaf.backer.addr.toString(), index, 1n * ALGO, leaf.txid, oracle, {
        budgetBooster: needsBoost(config),
      })
      leaf.spent = true
    }

    const sweeperBefore = await balanceOf(stack.algorand, stack.sweeperAddress)
    const vaultMinBefore = await minBalanceOf(stack.algorand, stack.vault.address)
    await advanceTime(fixture, VAULT_WINDOW_ADVANCE)
    await stack.vault.client.send.call({
      method: 'finalize(uint64)void',
      args: [campaign.appId],
      sender: at(backers, 0).addr,
      extraFee: microAlgos(FEE),
      suppressLog: true,
    })

    const spent = leaves.filter((leaf) => leaf.spent).length
    expect(await balanceOf(stack.algorand, stack.sweeperAddress)).toEqual(sweeperBefore + BigInt(config.maxN - spent) * ALGO)
    expect(await minBalanceOf(stack.algorand, stack.vault.address)).toEqual(vaultMinBefore - VAULT_BOX_MBR)
    expect(await campaignBoxExists(stack.vault.client, campaign.appId)).toEqual(false)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${describeScale(config)} seed=${seed.toString()} step=${actions.length.toString()}\nactions=${actions.join(' ')}\n${message}`,
    )
  }
}
