import { describe, expect, it } from 'vitest'
import { base32ToBytes, concatHashes, emptyTree, foldPeaks, nullLeaf, treePathFor, u64be, u64beDecode, zeroLeaf } from './index.js'

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

describe('claim-tree guards', () => {
  it('rejects unknown positions', () => {
    const state = emptyTree()
    expect(() => treePathFor(state, 0)).toThrow(RangeError)
    expect(() => nullLeaf(state, 0, 1n)).toThrow(RangeError)
  })

  it('rejects malformed inputs', () => {
    expect(() => u64beDecode(new Uint8Array(7))).toThrow('bad uint64 length')
    expect(() => base32ToBytes('!')).toThrow('bad base32 character')
  })

  it('decodes unpadded base32', () => {
    expect(hex(base32ToBytes('MZXW6'))).toEqual('666f6f')
  })

  it('encodes uint64 big-endian', () => {
    expect(hex(u64be(0x0203040506070809n))).toEqual('0203040506070809')
    expect(u64beDecode(u64be(123456789n))).toEqual(123456789n)
  })

  it('folds no peaks to zero and concatenates hashes', () => {
    expect(hex(foldPeaks([]))).toEqual(hex(zeroLeaf()))
    expect(concatHashes([]).length).toEqual(0)
  })
})
