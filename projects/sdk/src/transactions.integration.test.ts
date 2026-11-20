import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, test } from 'vitest'
import { CampaignFactory } from './generated/CampaignClient.js'
import { ClaimsVaultFactory } from './generated/ClaimsVaultClient.js'
import { RegistryFactory } from './generated/RegistryClient.js'
import type { CampaignHeader, WalletSession } from './index.js'
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
} from './index.js'

/**
 * LocalNet integration tests for the SDK send path: deploy the Registry + ClaimsVault from the ARC-56 bytecode embedded in the
 * generated clients, configure the SDK against them, and drive every write helper end to end. The contract suites prove the
 * compiled TEAL; this suite proves the SDK's group assembly, fee headroom, signer wiring, and indexer waits on a live chain.
 *
 * Requires `algokit localnet start`. The generated clients decide which contract release is under test: the pinned specs
 * release by default, or the local artifacts after `SDK_SPECS=local npm run codegen` (see docs/testing.md).
 */

const ALGO = 1_000_000n
const WINDOW = 30n * 24n * 60n * 60n
const FEE_PLEDGE = 4_000n // pay + pledge + credit (credit carries the first-touch registry check)
const FEE_SPEND = 5_000n // outer + 2 payout inners + 2 OpUp takes (zero-headroom sizing)
const FEE_VAULT_REFUND = 4_000n // outer + 1 payout inner + 2 OpUp takes
const FEE_CLAIM = 3_000n // inner payClaim + inner payment

describe('SDK send path (localnet)', () => {
  const fixture = algorandFixture()
  let algorand: AlgorandClient

  beforeAll(async () => {
    await fixture.newScope()
    algorand = fixture.context.algorand

    const owner = await fixture.context.generateAccount({ initialFunds: microAlgos(50n * ALGO), suppressLog: true })
    const ownerAddress = owner.addr.toString()

    const campaignFactory = new CampaignFactory({ algorand, defaultSender: ownerAddress })
    const vaultFactory = new ClaimsVaultFactory({ algorand, defaultSender: ownerAddress })
    const registry = new RegistryFactory({ algorand, defaultSender: ownerAddress })

    const { appClient: registryClient } = await registry.send.create.create({
      args: {
        campaignProgramHash: approvalClearHash(campaignFactory.appSpec),
        vaultProgramHash: approvalClearHash(vaultFactory.appSpec),
        expectedSweepTarget: ownerAddress,
        expectedRefundWindow: WINDOW,
      },
      sender: ownerAddress,
      suppressLog: true,
    })
    // The Registry account holds the registration deposits and pays them back, so it needs the account base on top of the MBR.
    await algorand.send.payment({ sender: ownerAddress, receiver: registryClient.appAddress, amount: microAlgos(ALGO), suppressLog: true })

    const { appClient: vaultClient } = await vaultFactory.send.create.create({
      args: { registry: registryClient.appId, target: ownerAddress, window: WINDOW },
      sender: ownerAddress,
      appReferences: [registryClient.appId],
      suppressLog: true,
    })
    // The vault's pooled box MBR is charged to its own account.
    await algorand.send.payment({ sender: ownerAddress, receiver: vaultClient.appAddress, amount: microAlgos(ALGO), suppressLog: true })

    // Bind the vault after both apps exist; the Registry checks the back-pointer, program hash, target, and window.
    await registryClient.send.bindVault({
      args: { vault: vaultClient.appId },
      sender: ownerAddress,
      appReferences: [vaultClient.appId],
      suppressLog: true,
    })

    configureSdk({ algorand, registryAppId: registryClient.appId, vaultAppId: vaultClient.appId })
  })

  async function session(initialAlgos: bigint): Promise<WalletSession> {
    const account = await fixture.context.generateAccount({ initialFunds: microAlgos(initialAlgos * ALGO), suppressLog: true })
    return { address: account.addr.toString(), signer: account.signer }
  }

  async function headerOf(appId: bigint): Promise<CampaignHeader> {
    const header = await fetchCampaignHeader(appId)
    if (header === undefined) throw new Error(`campaign ${appId.toString()} was not indexed`)
    return header
  }

  async function balanceOf(address: string): Promise<bigint> {
    return (await algorand.account.getInformation(address)).balance.microAlgo
  }

  async function advanceTime(seconds: number): Promise<void> {
    const algod = algorand.client.algod
    try {
      await algod.setBlockOffsetTimestamp(seconds).do()
      await algorand.send.payment({
        sender: fixture.context.testAccount.addr,
        receiver: fixture.context.testAccount.addr,
        amount: microAlgos(1_000n),
        suppressLog: true,
      })
    } finally {
      await algod.setBlockOffsetTimestamp(0).do()
    }
  }

  test('create → pledge → cancel → delete', async () => {
    const creator = await session(50n)
    const backer = await session(50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK open campaign', 'ipfs://sdk-open', 10n * ALGO, deadline)
    expect(await isRegistered(appId)).toBe(true)

    const backerBefore = await balanceOf(backer.address)
    await pledge(appId, backer, 2n * ALGO)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(2n * ALGO)

    const leaves = await fetchMyLeaves(appId, backer.address)
    expect(leaves).toHaveLength(1)
    const leaf = leaves[0]
    if (leaf === undefined) throw new Error('pledge leaf missing')
    await cancelPledge(appId, backer, leaf)

    expect(await fetchMyLeaves(appId, backer.address)).toEqual([])
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(0n)
    // Pledge group + cancel call: the backer pays both fees and gets the principal back.
    expect(await balanceOf(backer.address)).toEqual(backerBefore - FEE_PLEDGE - FEE_SPEND)

    await deleteCampaign(appId, creator)
    expect(await isRegistered(appId)).toBe(false)
    await expect(algorand.app.getById(appId)).rejects.toThrow()
  })

  test('successful campaign → claim → delete', async () => {
    const creator = await session(50n)
    const backer = await session(50n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK successful campaign', 'ipfs://sdk-success', ALGO, deadline)

    await pledge(appId, backer, ALGO)
    await advanceTime(90_001)

    const creatorBefore = await balanceOf(creator.address)
    await claim(appId, creator)
    expect(await balanceOf(creator.address)).toEqual(creatorBefore + ALGO - FEE_CLAIM)
    expect((await headerOf(appId)).status).toEqual('claimed')
    const box = await fetchVaultBox(appId)
    expect(box?.status).toEqual(3)
    expect(box?.paidIn).toEqual(ALGO)
    expect(box?.paidOut).toEqual(ALGO)

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
    const { appId } = await createCampaign(creator, 'SDK failed campaign', 'ipfs://sdk-failed', 10n * ALGO, deadline)

    await pledge(appId, backerA, 3n * ALGO)
    await pledge(appId, backerB, 2n * ALGO)
    await advanceTime(90_001)

    const leafA = (await fetchMyLeaves(appId, backerA.address))[0]
    if (leafA === undefined) throw new Error('backer A leaf missing')
    const backerABefore = await balanceOf(backerA.address)
    await refund(appId, backerA, leafA)
    expect(await balanceOf(backerA.address)).toEqual(backerABefore + 3n * ALGO - FEE_SPEND)
    expect(await fetchMyLeaves(appId, backerA.address)).toEqual([])
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(2n * ALGO)
    expect((await headerOf(appId)).status).toEqual('failed')

    await deleteCampaign(appId, creator)
    expect(await isRegistered(appId)).toBe(false)
    const settled = await fetchVaultBox(appId)
    expect(settled?.status).toEqual(2)
    expect(settled?.paidIn).toEqual(5n * ALGO)
    expect(settled?.paidOut).toEqual(3n * ALGO)
    const deletedHeader = await headerOf(appId)
    expect(deletedHeader.deleted).toBe(true)
    expect(deletedHeader.raisedMicroAlgos).toEqual(2n * ALGO)

    const leafB = (await fetchMyLeaves(appId, backerB.address))[0]
    if (leafB === undefined) throw new Error('backer B leaf missing')
    const backerBBefore = await balanceOf(backerB.address)
    await refund(appId, backerB, leafB)
    expect(await balanceOf(backerB.address)).toEqual(backerBBefore + 2n * ALGO - FEE_VAULT_REFUND)
    expect(await fetchMyLeaves(appId, backerB.address)).toEqual([])
    const box = await fetchVaultBox(appId)
    expect(box?.paidIn).toEqual(5n * ALGO)
    expect(box?.paidOut).toEqual(5n * ALGO)
  })

  test('mid-size tree → cancel and refund on both paths', async () => {
    const creator = await session(50n)
    const backer = await session(100n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK mid-size campaign', 'ipfs://sdk-mid', 100n * ALGO, deadline)

    for (let i = 0; i < 47; i++) await pledge(appId, backer, ALGO)
    const initial = await fetchMyLeaves(appId, backer.address)
    expect(initial).toHaveLength(47)

    // N=47, k=0: r=5, c=4 (nine path elements), so the cancel needs several OpUp takes.
    const leaf0 = initial.find((leaf) => leaf.position === 0)
    if (leaf0 === undefined) throw new Error('leaf 0 missing')
    await cancelPledge(appId, backer, leaf0)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(46n * ALGO)

    await advanceTime(90_001)

    const leaf1 = (await fetchMyLeaves(appId, backer.address)).find((leaf) => leaf.position === 1)
    if (leaf1 === undefined) throw new Error('leaf 1 missing')
    await refund(appId, backer, leaf1)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(45n * ALGO)
    expect((await headerOf(appId)).status).toEqual('failed')

    await deleteCampaign(appId, creator)

    const leaf2 = (await fetchMyLeaves(appId, backer.address)).find((leaf) => leaf.position === 2)
    if (leaf2 === undefined) throw new Error('leaf 2 missing')
    await refund(appId, backer, leaf2)
    const box = await fetchVaultBox(appId)
    expect(box?.paidIn).toEqual(47n * ALGO)
    expect(box?.paidOut).toEqual(3n * ALGO)
  })

  test('large tree → cancel and refund with a deep path', { timeout: 300_000 }, async () => {
    const creator = await session(50n)
    const backer = await session(300n)
    const deadline = (await fetchChainTimestamp()) + 90_000n
    const { appId } = await createCampaign(creator, 'SDK large campaign', 'ipfs://sdk-large', 1_000n * ALGO, deadline)

    for (let i = 0; i < 255; i++) await pledge(appId, backer, ALGO)
    const initial = await fetchMyLeaves(appId, backer.address)
    expect(initial).toHaveLength(255)

    // N=255, k=9: r=c=7 (14 path elements), the heaviest shape exercised by the contract ladder.
    const leaf9 = initial.find((leaf) => leaf.position === 9)
    if (leaf9 === undefined) throw new Error('leaf 9 missing')
    await cancelPledge(appId, backer, leaf9)
    expect((await headerOf(appId)).raisedMicroAlgos).toEqual(254n * ALGO)

    await advanceTime(90_001)

    const leaf10 = (await fetchMyLeaves(appId, backer.address)).find((leaf) => leaf.position === 10)
    if (leaf10 === undefined) throw new Error('leaf 10 missing')
    await refund(appId, backer, leaf10)
    await deleteCampaign(appId, creator)

    const leaf11 = (await fetchMyLeaves(appId, backer.address)).find((leaf) => leaf.position === 11)
    if (leaf11 === undefined) throw new Error('leaf 11 missing')
    await refund(appId, backer, leaf11)
    const box = await fetchVaultBox(appId)
    expect(box?.paidIn).toEqual(255n * ALGO)
    expect(box?.paidOut).toEqual(3n * ALGO)
  })
})

/**
 * The official program hash: `sha256(itob(approval.length) ‖ approval ‖ clear)`, from the ARC-56 bytecode under test.
 *
 * @param spec The compiled ARC-56 spec.
 * @returns The 32-byte program hash.
 */
function approvalClearHash(spec: Arc56Contract): Uint8Array {
  const approval = spec.byteCode?.approval
  const clear = spec.byteCode?.clear
  if (approval === undefined || clear === undefined) {
    throw new Error(`${spec.name} ARC-56 spec has no bytecode; regenerate the clients with codegen`)
  }
  const approvalBytes = Buffer.from(approval, 'base64')
  const clearBytes = Buffer.from(clear, 'base64')
  const length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(approvalBytes.length))
  return new Uint8Array(createHash('sha256').update(length).update(approvalBytes).update(clearBytes).digest())
}
