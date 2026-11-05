import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { SIZE_BUDGET } from './size-budget.fixture'

const ARTIFACTS = path.resolve(__dirname, 'artifacts')
const BASE_PAGE_BYTES = 2_048
const MAX_EXTRA_PAGES = 3
const APP_MBR_BASE = 100_000
const APP_MBR_BYTE = 50_000
const APP_MBR_UINT = 28_500
const APP_MBR_PAGE = 100_000

interface Arc56SizeFields {
  byteCode: { approval: string; clear: string }
  state: { schema: { global: { bytes: number; ints: number } } }
}

describe('contract size budget', () => {
  for (const [directory, budget] of Object.entries(SIZE_BUDGET)) {
    const { contract, ...expected } = budget

    test(`${contract} matches the pinned size and MBR`, () => {
      const specPath = path.join(ARTIFACTS, directory, `${contract}.arc56.json`)
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as Arc56SizeFields
      const approval = Buffer.from(spec.byteCode.approval, 'base64').length
      const clear = Buffer.from(spec.byteCode.clear, 'base64').length
      const total = approval + clear
      const extraPages = Math.max(0, Math.ceil(total / BASE_PAGE_BYTES) - 1)
      const pageCapacity = BASE_PAGE_BYTES * (extraPages + 1)
      const globalBytes = spec.state.schema.global.bytes
      const globalInts = spec.state.schema.global.ints
      const appMbr = APP_MBR_BASE + APP_MBR_BYTE * globalBytes + APP_MBR_UINT * globalInts + APP_MBR_PAGE * extraPages

      expect({ approval, clear, total, extraPages, pageCapacity, globalBytes, globalInts, appMbr }).toEqual(expected)
      expect(extraPages).toBeLessThanOrEqual(MAX_EXTRA_PAGES)
      expect(total).toBeLessThanOrEqual(pageCapacity)
    })
  }
})
