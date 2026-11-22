import { MAX_TREE_SIZE, ZERO_ROOT_HEX } from '@kasakame/constants'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
assert.equal(MAX_TREE_SIZE, 524287n)
assert.equal(ZERO_ROOT_HEX, '0'.repeat(64))
const source = require.resolve('@kasakame/constants/source')
assert.ok(source.endsWith('src/index.ts'), `/source resolved to ${source}`)
console.log('constants package smoke passed')
