import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { SPECS_VERSION } from './index.js'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json') as { config: { specsVersion: string } }

describe('SPECS_VERSION', () => {
  it('matches the pinned specs version', () => {
    expect(SPECS_VERSION).toBe(packageJson.config.specsVersion)
  })
})
