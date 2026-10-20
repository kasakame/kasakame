import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sdkDir = path.resolve(import.meta.dirname, '..')
const sdkPackage = JSON.parse(fs.readFileSync(path.join(sdkDir, 'package.json'), 'utf8'))
const expectedVersion = sdkPackage.version
const expectedSpecs = sdkPackage.config?.specsVersion

if (typeof expectedVersion !== 'string' || typeof expectedSpecs !== 'string') {
  throw new Error('package.json version or config.specsVersion is missing')
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasakame-sdk-smoke-'))
const packDir = path.join(tempDir, 'package')
const consumerDir = path.join(tempDir, 'consumer')
fs.mkdirSync(packDir)
fs.mkdirSync(consumerDir)

try {
  execFileSync('npm', ['pack', '--pack-destination', packDir], { cwd: sdkDir, stdio: 'inherit' })
  const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, `expected one tarball in ${packDir}`)
  const tarball = path.join(packDir, tarballs[0])

  fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({ name: 'sdk-smoke', private: true, type: 'module' }, null, 2))
  execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], {
    cwd: consumerDir,
    stdio: 'inherit',
  })

  const installedDir = path.join(consumerDir, 'node_modules', '@kasakame', 'sdk')
  const installed = JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8'))
  assert.equal(installed.version, expectedVersion, `installed version ${String(installed.version)}, expected ${expectedVersion}`)
  assert.equal(installed.license, 'MIT', `installed license ${String(installed.license)}, expected MIT`)
  assert.ok(fs.existsSync(path.join(installedDir, 'LICENSE')), 'installed package is missing LICENSE')

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
    env: { ...process.env, VERSION: expectedVersion, SPECS_VERSION: expectedSpecs },
  })
  console.log(`@kasakame/sdk@${expectedVersion} tarball smoke test passed (specs ${expectedSpecs})`)
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
