import { SPECS_VERSION, configureSdk, getCampaign, pledgeGroup, refundGroup } from '@kasakame/sdk'
import assert from 'node:assert/strict'
import process from 'node:process'

const api = { SPECS_VERSION, configureSdk, getCampaign, pledgeGroup, refundGroup }
assert.equal(typeof SPECS_VERSION, 'string', 'SPECS_VERSION is not a string')
for (const name of ['configureSdk', 'getCampaign', 'pledgeGroup', 'refundGroup'] as const) {
  assert.equal(typeof api[name], 'function', `missing function export: ${name}`)
}
const expectedSpecs = process.env.EXPECTED_SPECS_VERSION
assert.ok(expectedSpecs, 'EXPECTED_SPECS_VERSION is not set')
assert.equal(SPECS_VERSION, expectedSpecs, `SPECS_VERSION ${SPECS_VERSION} does not match ${expectedSpecs}`)
console.log(`@kasakame/sdk loaded; contracts ${SPECS_VERSION}`)
