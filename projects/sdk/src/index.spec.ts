import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { SPECS_VERSION } from './index.js'

const require = createRequire(import.meta.url)
const contractsPackage = require('../../contracts/package.json') as { version: string }

describe('SPECS_VERSION', () => {
  it('matches the contracts package version', () => {
    expect(SPECS_VERSION).toBe(contractsPackage.version)
  })
})
