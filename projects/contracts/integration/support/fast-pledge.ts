import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { ABIMethod, decodeAddress } from 'algosdk'
import { createHash } from 'node:crypto'
import {
  base32ToBytes,
  campaignState,
  FEE,
  PLEDGE_FEES,
  pledgeExtraFee,
  registrationBoxRef,
  spendExtraFee,
  vaultBoxRef,
  type ContractStack,
} from './localnet'

/**
 * Fast test-only pledge/spend helpers for the cap-scale suites (#220).
 *
 * The shared LocalNet helpers spawn the Python oracle and read account/box state on every pledge. At 524,287
 * positions that is both O(N^2) and tens of hours. This module keeps the frontier and the full leaf tree in memory,
 * builds the exact `[pay, campaign.pledge, vault.credit]` group without per-pledge ledger reads, and computes the
 * refund paths locally.
 *
 * Not a production client and not part of the `00`-`07` suites.
 */

const Z = new Uint8Array(32)

const sha = (data: Uint8Array): Uint8Array => createHash('sha512-256').update(data).digest()
const pair = (left: Uint8Array, right: Uint8Array): Uint8Array => sha(Buffer.concat([left, right]))

/**
 * Lower-case hex of a byte array.
 *
 * @param value The bytes.
 * @returns The hex string.
 */
export const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex')
const leafFor = (backer: string, amount: bigint, txidHex: string): Uint8Array => {
  const preimage = Buffer.alloc(73)
  preimage[0] = 0x01
  Buffer.from(decodeAddress(backer).publicKey).copy(preimage, 1)
  preimage.writeBigUInt64BE(amount, 33)
  Buffer.from(txidHex, 'hex').copy(preimage, 41)
  return sha(preimage)
}

interface PeaksWithLevels {
  level: number
  value: Uint8Array
}

function buildNodes(leaves: Uint8Array[]): Uint8Array[][] {
  const nodes: Uint8Array[][] = [leaves]
  for (let level = 1; 2 ** level <= leaves.length; level++) {
    const previous = nodes[level - 1] as Uint8Array[]
    const count = Math.floor(leaves.length / 2 ** level)
    const row: Uint8Array[] = []
    for (let i = 0; i < count; i++) row.push(pair(previous[2 * i] as Uint8Array, previous[2 * i + 1] as Uint8Array))
    nodes.push(row)
  }
  return nodes
}

function peaksWithLevels(n: number, nodes: Uint8Array[][]): PeaksWithLevels[] {
  const peaks: PeaksWithLevels[] = []
  for (let level = 0; 2 ** level <= n; level++) {
    if (((n >> level) & 1) === 1) peaks.push({ level, value: nodes[level]?.[(n >> level) - 1] as Uint8Array })
  }
  return peaks
}

function fold(peaks: Uint8Array[]): Uint8Array {
  if (peaks.length === 0) return Z
  let acc = peaks[peaks.length - 1] as Uint8Array
  for (let i = peaks.length - 2; i >= 0; i--) acc = pair(acc, peaks[i] as Uint8Array)
  return acc
}

/**
 * Derive the path shape for position k at size n, mirroring the contract's `pathLen`/popcount/top checks.
 *
 * @param n Tree size (positions ever appended).
 * @param k Leaf position.
 * @returns Sibling count r, lower-peak count c, and whether a top fold is present.
 */
function pathShape(n: number, k: number): { r: number; c: number; hasTop: boolean } {
  let r = 0
  for (let level = 0; level < 64; level++) {
    const i = Math.floor(k / 2 ** level)
    const sibling = i % 2 === 0 ? i + 1 : i - 1
    if ((sibling + 1) * 2 ** level <= n) r += 1
    else break
  }
  const mod = n - Math.floor(n / 2 ** r) * 2 ** r
  let c = 0
  let rest = mod
  while (rest > 0) {
    c += rest & 1
    rest >>>= 1
  }
  return { r, c, hasTop: Math.floor(n / 2 ** (r + 1)) > 0 }
}

/** A path split: siblings (r), optional top fold, lower peaks (c). */
export interface FastPath {
  siblings: Uint8Array[]
  top: Uint8Array | null
  lower: Uint8Array[]
}

/** The in-memory campaign tree: leaves, frontier peaks, txids, and paths. */
export class FastTree {
  readonly leaves: Uint8Array[] = []
  readonly txids: string[] = []
  private peaksValue: Uint8Array[] = []

  get n(): number {
    return this.leaves.length
  }

  get peaks(): Uint8Array[] {
    return this.peaksValue
  }

  root(): Uint8Array {
    return fold(this.peaksValue)
  }

  frontier(): Uint8Array {
    return Buffer.concat(this.peaksValue)
  }

  append(leaf: Uint8Array, txid: string): void {
    let merged = leaf
    const trailing = this.trailingOnes(this.leaves.length)
    for (let i = 0; i < trailing; i++) merged = pair(this.peaksValue[i] as Uint8Array, merged)
    this.peaksValue = [merged, ...this.peaksValue.slice(trailing)]
    this.leaves.push(leaf)
    this.txids.push(txid)
  }

  path(k: number): FastPath {
    const nodes = buildNodes(this.leaves)
    const { r } = pathShape(this.n, k)
    const siblings: Uint8Array[] = []
    for (let level = 0; level < r; level++) {
      const i = Math.floor(k / 2 ** level)
      siblings.push(nodes[level]?.[i % 2 === 0 ? i + 1 : i - 1] as Uint8Array)
    }
    const peaks = peaksWithLevels(this.n, nodes)
    const higher = peaks.filter((peak) => peak.level > r).map((peak) => peak.value)
    const lower = peaks.filter((peak) => peak.level < r).map((peak) => peak.value)
    return { siblings, top: higher.length === 0 ? null : fold(higher), lower }
  }

  pathBlob(k: number): Uint8Array {
    const path = this.path(k)
    return Buffer.concat([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
  }

  null(k: number): void {
    this.leaves[k] = Z
    const nodes = buildNodes(this.leaves)
    this.peaksValue = peaksWithLevels(this.n, nodes).map((peak) => peak.value)
  }

  private trailingOnes(n: number): number {
    let count = 0
    while (((n >> count) & 1) === 1) count += 1
    return count
  }
}

/** The fee-aware result of a fast pledge. */
export interface FastPledgeResult {
  index: number
  txid: string
  leaf: Uint8Array
  fee: bigint
}

/**
 * Build and send one pledge group, updating the in-memory tree.
 *
 * @param stack The deployed stack.
 * @param appId The campaign app id.
 * @param backer The payer and leaf owner.
 * @param amount Pledge amount in microAlgos.
 * @param tree The in-memory tree (frontier source and leaf store).
 * @returns The appended index, payment TxID, leaf hash, and fees paid.
 */
export async function fastPledge(
  stack: ContractStack,
  appId: bigint,
  backer: string,
  amount: bigint,
  tree: FastTree,
): Promise<FastPledgeResult> {
  const extraFee = pledgeExtraFee(tree.peaks.length)
  const pay = await stack.algorand.createTransaction.payment({
    sender: backer,
    receiver: stack.vault.address,
    amount: microAlgos(amount),
  })
  const composer = stack.algorand.send.newGroup()
  composer.addAppCallMethodCall({
    appId,
    method: ABIMethod.fromSignature('pledge(pay,byte[])void'),
    args: [pay, tree.frontier()],
    sender: backer,
    ...(extraFee > 0n ? { extraFee: microAlgos(extraFee) } : {}),
  })
  composer.addAppCallMethodCall({
    appId: stack.vault.appId,
    method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
    args: [appId, amount],
    sender: backer,
    appReferences: [stack.factory.appId],
    boxReferences: [vaultBoxRef(stack.vault.appId, appId), registrationBoxRef(stack.factory.appId, appId)],
    extraFee: microAlgos(FEE),
  })
  const result = await composer.send({ suppressLog: true, populateAppCallResources: false })
  const payTxid = result.txIds[0]
  if (payTxid === undefined) throw new Error('pledge group returned no payment TxID')
  const txid = Buffer.from(base32ToBytes(payTxid)).toString('hex')
  const leaf = leafFor(backer, amount, txid)
  const index = tree.n
  tree.append(leaf, txid)
  return { index, txid, leaf, fee: PLEDGE_FEES + extraFee }
}

/** The cap size (#220): 2^19 - 1, the largest tree the contract accepts. */
export const CAP_TREE_SIZE = 524_287
/** Pledge amount at the cap: 0.1 ALGO. */
export const CAP_AMOUNT = 100_000n

/** The principal and pledge fees spent to fill a tree. */
export interface CapPledgeRun {
  principal: bigint
  fees: bigint
}

/**
 * Fill a tree with cap-scale pledges, checking the on-chain root every 1,000 positions.
 *
 * @param stack The deployed stack.
 * @param appClient The campaign client (for the periodic root checks).
 * @param appId The campaign app id.
 * @param backer The payer and leaf owner.
 * @param tree The in-memory tree to fill.
 * @param count Number of pledges to send.
 * @returns The principal and total pledge fees paid.
 */
export async function runPledges(
  stack: ContractStack,
  appClient: AppClient,
  appId: bigint,
  backer: string,
  tree: FastTree,
  count: number,
): Promise<CapPledgeRun> {
  const startedAt = Date.now()
  let fees = 0n
  for (let i = 0; i < count; i++) {
    fees += (await fastPledge(stack, appId, backer, CAP_AMOUNT, tree)).fee
    const done = i + 1
    if (done % 1_000 === 0) {
      const state = await campaignState(appClient)
      if (state.n !== BigInt(done) || state.root !== hex(tree.root())) {
        throw new Error(`fast tree diverged at n=${done.toString()}: campaign n=${state.n.toString()}`)
      }
    }
    if (done % 25_000 === 0 || done === count) {
      const seconds = (Date.now() - startedAt) / 1_000
      const rate = done / seconds
      const etaMinutes = Math.round((count - done) / rate / 60)
      console.log(`${done.toString()}/${count.toString()} pledges, ${rate.toFixed(2)}/s, eta ${etaMinutes.toString()} min`)
    }
  }
  return { principal: BigInt(count) * CAP_AMOUNT, fees }
}

interface InnerTxnList {
  innerTxns?: unknown[]
}

async function simulatedTakeCount(composer: ReturnType<AlgorandClient['send']['newGroup']>): Promise<number> {
  const simulation = await composer.simulate({ allowUnnamedResources: true, skipSignatures: true })
  const last = simulation.simulateResponse.txnGroups[0]?.txnResults.at(-1)?.txnResult as InnerTxnList | undefined
  return Math.max(0, (last?.innerTxns?.length ?? 1) - 1)
}

/** The fee-aware result of a fast spend. */
export interface FastSpendResult {
  k: number
  takes: number
  fee: bigint
  path: FastPath
}

/**
 * Cancel/refund one leaf through the campaign (`cancelPledge`/`refund`), updating the tree.
 *
 * @param stack The deployed stack.
 * @param appId The campaign app id.
 * @param backer The leaf owner.
 * @param method The campaign spend method.
 * @param tree The in-memory tree.
 * @param k Leaf position.
 * @param amount Pledged amount committed by the leaf.
 * @returns The take count, fees paid, and path used.
 */
export async function fastSpend(
  stack: ContractStack,
  appId: bigint,
  backer: string,
  method: 'cancelPledge(uint64,uint64,byte[],byte[])void' | 'refund(uint64,uint64,byte[],byte[])void',
  tree: FastTree,
  k: number,
  amount: bigint,
): Promise<FastSpendResult> {
  const txid = tree.txids[k]
  if (txid === undefined) throw new Error(`unknown position: ${k.toString()}`)
  const path = tree.path(k)
  const hexPath = {
    siblings: path.siblings.map(hex),
    top: path.top === null ? null : hex(path.top),
    lower: path.lower.map(hex),
  }
  const extraFee = spendExtraFee(hexPath, 2)
  const composer = stack.algorand.send.newGroup()
  composer.addAppCallMethodCall({
    appId,
    method: ABIMethod.fromSignature(method),
    args: [BigInt(k), amount, Buffer.from(txid, 'hex'), tree.pathBlob(k)],
    sender: backer,
    appReferences: [stack.vault.appId],
    boxReferences: [vaultBoxRef(stack.vault.appId, appId)],
    extraFee: microAlgos(extraFee),
  })
  const takes = await simulatedTakeCount(composer)
  await composer.send({ suppressLog: true })
  tree.null(k)
  return { k, takes, fee: extraFee + FEE, path }
}

/**
 * Refund one leaf directly from the vault after campaign deletion, updating the tree.
 *
 * @param stack The deployed stack.
 * @param appId The campaign app id.
 * @param backer The leaf owner.
 * @param tree The in-memory tree.
 * @param k Leaf position.
 * @param amount Pledged amount committed by the leaf.
 * @returns The take count, fees paid, and path used.
 */
export async function fastVaultSpend(
  stack: ContractStack,
  appId: bigint,
  backer: string,
  tree: FastTree,
  k: number,
  amount: bigint,
): Promise<FastSpendResult> {
  const txid = tree.txids[k]
  if (txid === undefined) throw new Error(`unknown position: ${k.toString()}`)
  const path = tree.path(k)
  const hexPath = {
    siblings: path.siblings.map(hex),
    top: path.top === null ? null : hex(path.top),
    lower: path.lower.map(hex),
  }
  const extraFee = spendExtraFee(hexPath, 1)
  const composer = stack.algorand.send.newGroup()
  composer.addAppCallMethodCall({
    appId: stack.vault.appId,
    method: ABIMethod.fromSignature('refund(uint64,uint64,uint64,byte[],byte[])void'),
    args: [appId, BigInt(k), amount, Buffer.from(txid, 'hex'), tree.pathBlob(k)],
    sender: backer,
    boxReferences: [vaultBoxRef(stack.vault.appId, appId)],
    extraFee: microAlgos(extraFee),
  })
  const takes = await simulatedTakeCount(composer)
  await composer.send({ suppressLog: true })
  tree.null(k)
  return { k, takes, fee: extraFee + FEE, path }
}

/** The leaf hash for a pledge (exported for tests/assertions). */
export { leafFor, pathShape }
