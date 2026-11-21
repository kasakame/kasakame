import {
  APP_MBR_BASE_MICRO_ALGOS,
  APP_MBR_BYTE_MICRO_ALGOS,
  APP_MBR_PAGE_MICRO_ALGOS,
  APP_MBR_UINT_MICRO_ALGOS,
  APP_PAGE_BYTES,
  MAX_EXTRA_PAGES,
} from '@kasakame/constants'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { CONTRACT_SIZES } from './helpers/contract-sizes'

const ARTIFACTS = path.resolve(__dirname, '../smart_contracts/artifacts')

interface Arc56SizeFields {
  byteCode: { approval: string; clear: string }
  state: { schema: { global: { bytes: number; ints: number } } }
}

const TEST_IDS = {
  campaign: 'CON-300',
  claimsvault: 'CON-301',
  registry: 'CON-302',
} satisfies Record<keyof typeof CONTRACT_SIZES, string>

describe('contract size budget', () => {
  for (const directory of Object.keys(CONTRACT_SIZES) as Array<keyof typeof CONTRACT_SIZES>) {
    const { contract, ...expected } = CONTRACT_SIZES[directory]

    test(`${TEST_IDS[directory]} ${contract} matches the pinned size and MBR`, () => {
      const specPath = path.join(ARTIFACTS, directory, `${contract}.arc56.json`)
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as Arc56SizeFields
      const approval = Buffer.from(spec.byteCode.approval, 'base64').length
      const clear = Buffer.from(spec.byteCode.clear, 'base64').length
      const total = approval + clear
      const extraPages = Math.max(0, Math.ceil(total / APP_PAGE_BYTES) - 1)
      const pageCapacity = APP_PAGE_BYTES * (extraPages + 1)
      const globalBytes = spec.state.schema.global.bytes
      const globalInts = spec.state.schema.global.ints
      const appMbr =
        APP_MBR_BASE_MICRO_ALGOS +
        APP_MBR_BYTE_MICRO_ALGOS * globalBytes +
        APP_MBR_UINT_MICRO_ALGOS * globalInts +
        APP_MBR_PAGE_MICRO_ALGOS * extraPages

      expect({ approval, clear, total, extraPages, pageCapacity, globalBytes, globalInts, appMbr }).toEqual(expected)
      expect(extraPages).toBeLessThanOrEqual(MAX_EXTRA_PAGES)
      expect(total).toBeLessThanOrEqual(pageCapacity)
    })
  }
})
