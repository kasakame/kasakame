import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const constantsModule = '@kasakame/constants'
const constants = (await import(constantsModule)) as { MAX_TREE_SIZE?: unknown; ZERO_ROOT_HEX?: unknown }
assert.equal(constants.MAX_TREE_SIZE, 524287n)
assert.equal(constants.ZERO_ROOT_HEX, '0'.repeat(64))
const source = require.resolve('@kasakame/constants/source')
assert.ok(source.endsWith('src/index.ts'), `/source resolved to ${source}`)
console.log('constants package smoke passed')
