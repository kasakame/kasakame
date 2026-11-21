import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { CLAIM_FEE_MICRO_ALGOS, MICRO_ALGOS_PER_ALGO, MIN_REFUND_WINDOW_SECONDS, PLEDGE_GROUP_FEE_MICRO_ALGOS } from '@kasakame/constants'
import { specProgramHash } from '@kasakame/utils'
import { advanceTime, balanceOf, deployPlatform } from '@kasakame/utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'
import { CampaignFactory } from '../src/generated/CampaignClient.js'
import { ClaimsVaultFactory } from '../src/generated/ClaimsVaultClient.js'
import { RegistryFactory } from '../src/generated/RegistryClient.js'
import {
  cancelPledge,
  claim,
  configureSdk,
  createCampaign,
  deleteCampaign,
  fetchCampaignHeader,
  fetchChainTimestamp,
  fetchMyLeaves,
  fetchVaultBox,
  isRegistered,
  pledge,
  refund,
  type CampaignHeader,
  type WalletSession,
} from '../src/index.js'

/**
 * LocalNet integration tests for the SDK send path: deploy the Registry + ClaimsVault from the ARC-56 bytecode embedded in the
 * generated clients, configure the SDK against them, and drive every write helper end to end. The contract suites prove the
 * compiled TEAL; this suite proves the SDK's group assembly, fee headroom, signer wiring, and indexer waits on a live chain.
 *
 * Requires `algokit localnet start`. The generated clients decide which contract release is under test: the pinned specs
 * release by default, or the local artifacts after `SDK_SPECS=local npm run codegen` (see docs/testing.md).
 */

const FEE_SPEND = 5_000n // outer + 2 payout inners + 2 OpUp takes (zero-headroom sizing)
const FEE_VAULT_REFUND = 4_000n // outer + 1 payout inner + 2 OpUp takes

describe('SDK send path (localnet)', () => {
  const fixture = algorandFixture()
  let algorand: AlgorandClient

  beforeAll(async () => {
    await fixture.newScope()
    algorand = fixture.context.algorand

    const owner = await fixture.context.generateAccount({ initialFunds: microAlgos(50n * MICRO_ALGOS_PER_ALGO), suppressLog: true })
    const ownerAddress = owner.addr.toString()

    const campaignFactory = new CampaignFactory({ algorand, defaultSender: ownerAddress })
    const vaultFactory = new ClaimsVaultFactory({ algorand, defaultSender: ownerAddress })
    const registryFactory = new RegistryFactory({ algorand, defaultSender: ownerAddress })

    const { registry, vault } = await deployPlatform(algorand, {
      specs: { registry: registryFactory.appSpec, vault: vaultFactory.appSpec },
      owner,
      sweepTarget: ownerAddress,
      vaultWindowSeconds: BigInt(MIN_REFUND_WINDOW_SECONDS),
      campaignProgramHash: specProgramHash(campaignFactory.appSpec, 'Campaign'),
    })

    configureSdk({ algorand, registryAppId: registry.appId, vaultAppId: vault.appId })
  })

  async function session(initialAlgos: bigint): Promise<WalletSession> {
    const account = await fixture.context.generateAccount({
      initialFunds: microAlgos(initialAlgos * MICRO_ALGOS_PER_ALGO),
      suppressLog: true,
    })
    return { address: account.addr.toString(), signer: account.signer }
  }

  async function headerOf(appId: bigint): Promise<CampaignHeader> {
    const header = await fetchCampaignHeader(appId)
    if (header === undefined) throw new Error(`campaign ${appId.toString()} was not indexed`)
    return header
  }

  test('create → pledge → cancel → delete', async () => {
    const creator = await session(50n)
    const backer = await session(50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK open campaign', 'ipfs://sdk-open', 10n * MICRO_ALGOS_PER_ALGO, deadline)
    expect(await isRegistered(appId)).toBe(true)

    const backerBefore = await balanceOf(algorand, backer.address)
    await pledge(appId, backer, 2n * MICRO_ALGOS_PER_ALGO)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(2n * MICRO_ALGOS_PER_ALGO)

    const leaves = await fetchMyLeaves(appId, backer.address)
    expect(leaves).toHaveLength(1)
    const leaf = leaves[0]
    if (leaf === undefined) throw new Error('pledge leaf missing')
    await cancelPledge(appId, backer, leaf)

    expect(await fetchMyLeaves(appId, backer.address)).toEqual([])
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(0n)
    // Pledge group + cancel call: the backer pays both fees and gets the principal back.
    expect(await balanceOf(algorand, backer.address)).toEqual(backerBefore - PLEDGE_GROUP_FEE_MICRO_ALGOS - FEE_SPEND)

    await deleteCampaign(appId, creator)
    expect(await isRegistered(appId)).toBe(false)
    await expect(algorand.app.getById(appId)).rejects.toThrow()
  })

  test('successful campaign → claim → delete', async () => {
    const creator = await session(50n)
    const backer = await session(50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK successful campaign', 'ipfs://sdk-success', MICRO_ALGOS_PER_ALGO, deadline)

    await pledge(appId, backer, MICRO_ALGOS_PER_ALGO)
    await advanceTime(fixture, 90_001)

    const creatorBefore = await balanceOf(algorand, creator.address)
    await claim(appId, creator)
    expect(await balanceOf(algorand, creator.address)).toEqual(creatorBefore + MICRO_ALGOS_PER_ALGO - CLAIM_FEE_MICRO_ALGOS)
    expect((await headerOf(appId)).status).toEqual('claimed')
    const box = await fetchVaultBox(appId)
    expect(box?.status).toEqual(3)
    expect(box?.paidIn).toEqual(MICRO_ALGOS_PER_ALGO)
    expect(box?.paidOut).toEqual(MICRO_ALGOS_PER_ALGO)

    await deleteCampaign(appId, creator)
    expect(await isRegistered(appId)).toBe(false)
    expect(await fetchVaultBox(appId)).toBeUndefined()
    await expect(algorand.app.getById(appId)).rejects.toThrow()
  })

  test('failed campaign → refund before delete → delete → refund after delete', async () => {
    const creator = await session(50n)
    const backerA = await session(50n)
    const backerB = await session(50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK failed campaign', 'ipfs://sdk-failed', 10n * MICRO_ALGOS_PER_ALGO, deadline)

    await pledge(appId, backerA, 3n * MICRO_ALGOS_PER_ALGO)
    await pledge(appId, backerB, 2n * MICRO_ALGOS_PER_ALGO)
    await advanceTime(fixture, 90_001)

    const leafA = (await fetchMyLeaves(appId, backerA.address))[0]
    if (leafA === undefined) throw new Error('backer A leaf missing')
    const backerABefore = await balanceOf(algorand, backerA.address)
    await refund(appId, backerA, leafA)
    expect(await balanceOf(algorand, backerA.address)).toEqual(backerABefore + 3n * MICRO_ALGOS_PER_ALGO - FEE_SPEND)
    expect(await fetchMyLeaves(appId, backerA.address)).toEqual([])
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(2n * MICRO_ALGOS_PER_ALGO)
    expect((await headerOf(appId)).status).toEqual('failed')

    await deleteCampaign(appId, creator)
    expect(await isRegistered(appId)).toBe(false)
    const settled = await fetchVaultBox(appId)
    expect(settled?.status).toEqual(2)
    expect(settled?.paidIn).toEqual(5n * MICRO_ALGOS_PER_ALGO)
    expect(settled?.paidOut).toEqual(3n * MICRO_ALGOS_PER_ALGO)
    const deletedHeader = await headerOf(appId)
    expect(deletedHeader.deleted).toBe(true)
    expect(deletedHeader.raisedMicroAlgos).toEqual(2n * MICRO_ALGOS_PER_ALGO)

    const leafB = (await fetchMyLeaves(appId, backerB.address))[0]
    if (leafB === undefined) throw new Error('backer B leaf missing')
    const backerBBefore = await balanceOf(algorand, backerB.address)
    await refund(appId, backerB, leafB)
    expect(await balanceOf(algorand, backerB.address)).toEqual(backerBBefore + 2n * MICRO_ALGOS_PER_ALGO - FEE_VAULT_REFUND)
    expect(await fetchMyLeaves(appId, backerB.address)).toEqual([])
    const box = await fetchVaultBox(appId)
    expect(box?.paidIn).toEqual(5n * MICRO_ALGOS_PER_ALGO)
    expect(box?.paidOut).toEqual(5n * MICRO_ALGOS_PER_ALGO)
  })

  test('mid-size tree → cancel and refund on both paths', async () => {
    const creator = await session(50n)
    const backer = await session(100n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK mid-size campaign', 'ipfs://sdk-mid', 100n * MICRO_ALGOS_PER_ALGO, deadline)

    for (let i = 0; i < 47; i++) await pledge(appId, backer, MICRO_ALGOS_PER_ALGO)
    const initial = await fetchMyLeaves(appId, backer.address)
    expect(initial).toHaveLength(47)

    // N=47, k=0: r=5, c=4 (nine path elements), so the cancel needs several OpUp takes.
    const leaf0 = initial.find((leaf) => leaf.position === 0)
    if (leaf0 === undefined) throw new Error('leaf 0 missing')
    await cancelPledge(appId, backer, leaf0)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(46n * MICRO_ALGOS_PER_ALGO)

    await advanceTime(fixture, 90_001)

    const leaf1 = (await fetchMyLeaves(appId, backer.address)).find((leaf) => leaf.position === 1)
    if (leaf1 === undefined) throw new Error('leaf 1 missing')
    await refund(appId, backer, leaf1)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(45n * MICRO_ALGOS_PER_ALGO)
    expect((await headerOf(appId)).status).toEqual('failed')

    await deleteCampaign(appId, creator)

    const leaf2 = (await fetchMyLeaves(appId, backer.address)).find((leaf) => leaf.position === 2)
    if (leaf2 === undefined) throw new Error('leaf 2 missing')
    await refund(appId, backer, leaf2)
    const box = await fetchVaultBox(appId)
    expect(box?.paidIn).toEqual(47n * MICRO_ALGOS_PER_ALGO)
    expect(box?.paidOut).toEqual(3n * MICRO_ALGOS_PER_ALGO)
  })

  test('large tree → cancel and refund with a deep path', { timeout: 300_000 }, async () => {
    const creator = await session(50n)
    const backer = await session(300n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK large campaign', 'ipfs://sdk-large', 1_000n * MICRO_ALGOS_PER_ALGO, deadline)

    for (let i = 0; i < 255; i++) await pledge(appId, backer, MICRO_ALGOS_PER_ALGO)
    const initial = await fetchMyLeaves(appId, backer.address)
    expect(initial).toHaveLength(255)

    // N=255, k=9: r=c=7 (14 path elements), the heaviest shape exercised by the contract ladder.
    const leaf9 = initial.find((leaf) => leaf.position === 9)
    if (leaf9 === undefined) throw new Error('leaf 9 missing')
    await cancelPledge(appId, backer, leaf9)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(254n * MICRO_ALGOS_PER_ALGO)

    await advanceTime(fixture, 90_001)

    const leaf10 = (await fetchMyLeaves(appId, backer.address)).find((leaf) => leaf.position === 10)
    if (leaf10 === undefined) throw new Error('leaf 10 missing')
    await refund(appId, backer, leaf10)
    await deleteCampaign(appId, creator)

    const leaf11 = (await fetchMyLeaves(appId, backer.address)).find((leaf) => leaf.position === 11)
    if (leaf11 === undefined) throw new Error('leaf 11 missing')
    await refund(appId, backer, leaf11)
    const box = await fetchVaultBox(appId)
    expect(box?.paidIn).toEqual(255n * MICRO_ALGOS_PER_ALGO)
    expect(box?.paidOut).toEqual(3n * MICRO_ALGOS_PER_ALGO)
  })
})
