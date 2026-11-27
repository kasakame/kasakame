import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const sdkModule = '@kasakame/sdk'
const sdk = (await import(sdkModule)) as {
  SPECS_VERSION?: unknown
  configureSdk?: unknown
  getCampaign?: unknown
  pledgeGroup?: unknown
  refundGroup?: unknown
}

const specsVersion = sdk.SPECS_VERSION
if (typeof specsVersion !== 'string') {
  throw new Error('SPECS_VERSION is not a string')
}
for (const name of ['configureSdk', 'getCampaign', 'pledgeGroup', 'refundGroup'] as const) {
  assert.equal(typeof sdk[name], 'function', `missing function export: ${name}`)
}
const algokitUtils = (await import('@algorandfoundation/algokit-utils')) as { AlgorandClient?: unknown }
assert.equal(typeof algokitUtils.AlgorandClient, 'function', 'missing peer: @algorandfoundation/algokit-utils')
const expectedSpecs = process.env.EXPECTED_SPECS_VERSION
assert.ok(expectedSpecs, 'EXPECTED_SPECS_VERSION is not set')
assert.equal(specsVersion, expectedSpecs, `SPECS_VERSION ${specsVersion} does not match ${expectedSpecs}`)

// The tarball ships only dist, so every JavaScript source map must embed the TypeScript sources.
const distDir = path.dirname(fileURLToPath(import.meta.resolve(sdkModule)))
const distFiles = fs.readdirSync(distDir, { recursive: true, encoding: 'utf8' })
const jsMaps = distFiles.filter((file) => file.endsWith('.js.map'))
assert.ok(jsMaps.length > 0, 'no JavaScript source maps published')
for (const file of jsMaps) {
  const sourceMap = JSON.parse(fs.readFileSync(path.join(distDir, file), 'utf8')) as {
    sourcesContent?: unknown
  }
  assert.ok(Array.isArray(sourceMap.sourcesContent) && sourceMap.sourcesContent.length > 0, `${file} has no inline sources`)
}
assert.equal(
  distFiles.some((file) => file.endsWith('.d.ts.map')),
  false,
  'declaration maps must not be published',
)
console.log(`@kasakame/sdk loaded; contracts ${specsVersion}; source maps embed sources`)
