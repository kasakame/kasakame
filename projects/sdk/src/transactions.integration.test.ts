import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, test } from 'vitest'
import { CampaignFactory } from './generated/CampaignClient.js'
import { ClaimsVaultFactory } from './generated/ClaimsVaultClient.js'
import { FactoryFactory } from './generated/FactoryClient.js'
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
 * LocalNet integration tests for the SDK send path: deploy the Factory + ClaimsVault from the ARC-56 bytecode embedded in the
 * generated clients, configure the SDK against them, and drive every write helper end to end. The contract suites prove the
 * compiled TEAL; this suite proves the SDK's group assembly, fee headroom, signer wiring, and indexer waits on a live chain.
 *
 * Requires `algokit localnet start`. The generated clients decide which contract release is under test: the pinned specs
 * release by default, or the local artifacts after `SDK_SPECS=local npm run codegen` (see docs/testing.md).
 */

const ALGO = 1_000_000n
const WINDOW = 3_600n
const FEE_PLEDGE = 4_000n // pay + pledge + credit (credit carries the first-touch factory check)
const FEE_SPEND = 4_000n // 1 OpUp iteration (create+delete) + payout call
const FEE_CLAIM = 3_000n // inner payClaim + inner payment

describe('SDK send path (localnet)', () => {
  const fixture = algorandFixture()
  let algorand: AlgorandClient

  beforeAll(async () => {
    await fixture.newScope()
    algorand = fixture.context.algorand

    const owner = await fixture.context.generateAccount({ initialFunds: microAlgos(50n * ALGO), suppressLog: true })
    const ownerAddress = owner.addr.toString()

    const factory = new FactoryFactory({ algorand, defaultSender: ownerAddress })
    const { appClient: factoryClient } = await factory.send.create.create({ args: [], sender: ownerAddress, suppressLog: true })
    // The Factory account holds the registration deposits and pays them back, so it needs the account base on top of the MBR.
    await algorand.send.payment({ sender: ownerAddress, receiver: factoryClient.appAddress, amount: microAlgos(ALGO), suppressLog: true })

    const vaultFactory = new ClaimsVaultFactory({ algorand, defaultSender: ownerAddress })
    const { appClient: vaultClient } = await vaultFactory.send.create.create({
      args: { factory: factoryClient.appId, target: ownerAddress, window: WINDOW },
      sender: ownerAddress,
      appReferences: [factoryClient.appId],
      suppressLog: true,
    })
    // The vault's pooled box MBR is charged to its own account.
    await algorand.send.payment({ sender: ownerAddress, receiver: vaultClient.appAddress, amount: microAlgos(ALGO), suppressLog: true })

    // 2026-11 Factory specs bind the vault and hash approval ‖ clear with a length prefix; the pinned release predates both.
    const legacyFactory = !factory.appSpec.methods.some((method) => method.name === 'setVault')
    if (!legacyFactory) {
      await factoryClient.appClient.send.call({
        method: 'setVault(uint64)void',
        args: [vaultClient.appId],
        sender: ownerAddress,
        appReferences: [vaultClient.appId],
        suppressLog: true,
      })
    }
    await factoryClient.send.setApprovalHash({
      args: { hash: officialCampaignHash(algorand, legacyFactory) },
      sender: ownerAddress,
      suppressLog: true,
    })

    configureSdk({ algorand, factoryAppId: factoryClient.appId, vaultAppId: vaultClient.appId })
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
    const deadline = (await fetchChainTimestamp()) + 3_600n
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
    const deadline = (await fetchChainTimestamp()) + 60n
    const { appId } = await createCampaign(creator, 'SDK successful campaign', 'ipfs://sdk-success', ALGO, deadline)

    await pledge(appId, backer, ALGO)
    await advanceTime(120)

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
    const deadline = (await fetchChainTimestamp()) + 60n
    const { appId } = await createCampaign(creator, 'SDK failed campaign', 'ipfs://sdk-failed', 10n * ALGO, deadline)

    await pledge(appId, backerA, 3n * ALGO)
    await pledge(appId, backerB, 2n * ALGO)
    await advanceTime(120)

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
    expect(await balanceOf(backerB.address)).toEqual(backerBBefore + 2n * ALGO - FEE_SPEND)
    expect(await fetchMyLeaves(appId, backerB.address)).toEqual([])
    const box = await fetchVaultBox(appId)
    expect(box?.paidIn).toEqual(5n * ALGO)
    expect(box?.paidOut).toEqual(5n * ALGO)
  })
})

/**
 * The Factory's official Campaign program hash, taken from the Campaign ARC-56 bytecode under test.
 *
 * @param algorand The configured Algorand client.
 * @param legacyFactory Whether the generated Factory specs predate the 2026-11 approval/clear hash.
 * @returns The 32-byte program hash.
 */
function officialCampaignHash(algorand: AlgorandClient, legacyFactory: boolean): Uint8Array {
  const spec = new CampaignFactory({ algorand }).appSpec
  const approval = spec.byteCode?.approval
  const clear = spec.byteCode?.clear
  if (approval === undefined || clear === undefined) {
    throw new Error('Campaign ARC-56 spec has no bytecode; regenerate the clients with codegen')
  }
  const approvalBytes = Buffer.from(approval, 'base64')
  const clearBytes = Buffer.from(clear, 'base64')
  const digest = createHash('sha256')
  if (legacyFactory) {
    // The pinned release Factory hashes the approval program alone.
    digest.update(approvalBytes)
  } else {
    // The current Factory binds the approval/clear split with an 8-byte length prefix.
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(approvalBytes.length))
    digest.update(length).update(approvalBytes).update(clearBytes)
  }
  return new Uint8Array(digest.digest())
}
