import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { packSmoke } from '../../../scripts/pack-smoke.mjs'

const packageDir = path.resolve(import.meta.dirname, '..')

packSmoke({
  packageDir,
  consumerName: 'sdk-smoke',
  verify: ({ consumerDir, packageJson, version }) => {
    const specsVersion = packageJson.config?.specsVersion
    if (typeof specsVersion !== 'string') {
      throw new Error('package.json config.specsVersion is missing')
    }

    fs.writeFileSync(
      path.join(consumerDir, 'smoke.mjs'),
      `import { SPECS_VERSION, configureSdk, getCampaign, pledgeGroup, refundGroup } from '@kasakame/sdk'

const api = { SPECS_VERSION, configureSdk, getCampaign, pledgeGroup, refundGroup }
if (typeof SPECS_VERSION !== 'string') throw new Error('SPECS_VERSION is not a string')
for (const name of ['configureSdk', 'getCampaign', 'pledgeGroup', 'refundGroup']) {
  if (typeof api[name] !== 'function') throw new Error('missing function export: ' + name)
}
if (SPECS_VERSION !== process.env.SPECS_VERSION) {
  throw new Error('SPECS_VERSION ' + SPECS_VERSION + ' does not match pin ' + process.env.SPECS_VERSION)
}
console.log('@kasakame/sdk@' + process.env.VERSION + ' loaded; specs ' + SPECS_VERSION)
`,
    )
    execFileSync(process.execPath, ['smoke.mjs'], {
      cwd: consumerDir,
      stdio: 'inherit',
      env: { ...process.env, VERSION: version, SPECS_VERSION: specsVersion },
    })
    console.log(`@kasakame/sdk@${version} tarball smoke test passed (specs ${specsVersion})`)
  },
})
