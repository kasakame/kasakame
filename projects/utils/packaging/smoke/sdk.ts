import assert from 'node:assert/strict'
import process from 'node:process'

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
const expectedSpecs = process.env.EXPECTED_SPECS_VERSION
assert.ok(expectedSpecs, 'EXPECTED_SPECS_VERSION is not set')
assert.equal(specsVersion, expectedSpecs, `SPECS_VERSION ${specsVersion} does not match ${expectedSpecs}`)
console.log(`@kasakame/sdk loaded; contracts ${specsVersion}`)
