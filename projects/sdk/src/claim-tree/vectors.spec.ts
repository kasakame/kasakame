import { encodeAddress } from 'algosdk'
import { describe, expect, it } from 'vitest'
import { CLAIM_TREE_VECTORS } from './claim-tree.vectors.js'
import {
  appendLeaf,
  emptyTree,
  foldPeaks,
  frontierForPledge,
  leafFor,
  nullLeaf,
  pathBlobForRefund,
  pathShape,
  treeFrontier,
  treePathFor,
  treeRoot,
  zeroLeaf,
} from './index.js'

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

describe('claim-tree vectors (differential vs the Python oracle)', () => {
  it('replays every vector step: roots, totals, frontiers, and paths', () => {
    let state = emptyTree()
    expect(hex(treeRoot(state))).toEqual(hex(zeroLeaf()))

    for (const step of CLAIM_TREE_VECTORS.steps) {
      if (step.op === 'append') {
        // The generator's address must decode to its pubkey (validates the checksum construction).
        expect(encodeAddress(Buffer.from(step.backerPubkey, 'hex'))).toEqual(step.backerAddress)
        const frontier = treeFrontier(state).map((peak) => hex(peak))
        expect(frontier).toEqual(step.frontier)

        state = appendLeaf(state, { backer: step.backerAddress, amount: BigInt(step.amount), txidHex: step.txid })
        expect(state.leaves.length).toEqual(step.expect.n)
        expect(hex(treeRoot(state))).toEqual(step.expect.root)
        expect(state.raised).toEqual(BigInt(step.expect.raised))
      } else {
        const path = treePathFor(state, step.k)
        expect(path.siblings.map((sibling) => hex(sibling))).toEqual(step.path.siblings)
        expect(path.top === null ? null : hex(path.top)).toEqual(step.path.top)
        expect(path.lower.map((peak) => hex(peak))).toEqual(step.path.lower)

        state = nullLeaf(state, step.k, BigInt(step.amount))
        expect(state.leaves.length).toEqual(step.expect.n)
        expect(hex(treeRoot(state))).toEqual(step.expect.root)
        expect(state.raised).toEqual(BigInt(step.expect.raised))
      }
    }
  })

  it('binds leaves to backer, amount, and txid', () => {
    const backerA = encodeAddress(new Uint8Array(32).fill(7))
    const backerB = encodeAddress(new Uint8Array(32).fill(8))
    expect(hex(leafFor(backerA, 1n, '00'.repeat(32)))).not.toEqual(hex(leafFor(backerB, 1n, '00'.repeat(32))))
    expect(hex(leafFor(backerA, 1n, '00'.repeat(32)))).not.toEqual(hex(leafFor(backerA, 2n, '00'.repeat(32))))
    expect(hex(leafFor(backerA, 1n, '00'.repeat(32)))).not.toEqual(hex(leafFor(backerA, 1n, '11'.repeat(32))))
  })

  it('round-trips pledge and refund call args', () => {
    const backer = encodeAddress(new Uint8Array(32).fill(7))
    let state = emptyTree()
    state = appendLeaf(state, { backer, amount: 5n, txidHex: '11'.repeat(32) })
    state = appendLeaf(state, { backer, amount: 6n, txidHex: '22'.repeat(32) })
    state = appendLeaf(state, { backer, amount: 7n, txidHex: '33'.repeat(32) })
    // N=3: two peaks (levels 0 and 1); k=2 has r=0 with a higher fold.
    expect(frontierForPledge(state).length).toEqual(64)
    const blob = pathBlobForRefund(state, 2)
    expect(blob.length).toEqual(32)
    // k=0 at N=3: one sibling plus one lower peak, no top.
    expect(pathBlobForRefund(state, 0).length).toEqual(64)
    expect(pathShape(3n, 2n)).toEqual({ r: 0, c: 0, hasTop: true })
    expect(pathShape(4n, 0n)).toEqual({ r: 2, c: 0, hasTop: false })
  })

  it('appends 2,000 leaves within the documented bound', () => {
    const backer = encodeAddress(new Uint8Array(32).fill(9))
    const started = performance.now()
    let state = emptyTree()
    for (let index = 0; index < 2_000; index++) {
      state = appendLeaf(state, { backer, amount: BigInt(index + 1), txidHex: '11'.repeat(32) })
    }
    const elapsed = performance.now() - started

    expect(state.leaves).toHaveLength(2_000)
    expect(state.frontier).toEqual(treeFrontier(state))
    expect(hex(treeRoot(state))).toEqual(hex(foldPeaks(treeFrontier(state))))
    // The old replay rebuilt the frontier per append and took tens of seconds; 5s leaves CI headroom.
    expect(elapsed).toBeLessThan(5_000)
  })

  it('rebuilds the frontier for a state that does not carry one', () => {
    const backer = encodeAddress(new Uint8Array(32).fill(10))
    const first = appendLeaf(emptyTree(), { backer, amount: 1n, txidHex: '11'.repeat(32) })
    const legacy = { leaves: first.leaves, raised: first.raised }
    const grown = appendLeaf(legacy, { backer, amount: 2n, txidHex: '22'.repeat(32) })

    expect(grown.frontier).toEqual(treeFrontier(grown))
  })
})
