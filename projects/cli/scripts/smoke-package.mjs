import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cliDir = path.resolve(import.meta.dirname, '..')
const cliPackage = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8'))
const expectedVersion = cliPackage.version

if (typeof expectedVersion !== 'string') {
  throw new Error('package.json version is missing')
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasakame-cli-smoke-'))
const packDir = path.join(tempDir, 'package')
const consumerDir = path.join(tempDir, 'consumer')
fs.mkdirSync(packDir)
fs.mkdirSync(consumerDir)

try {
  execFileSync('npm', ['pack', '--pack-destination', packDir], { cwd: cliDir, stdio: 'inherit' })
  const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, `expected one tarball in ${packDir}`)
  const tarball = path.join(packDir, tarballs[0])

  fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({ name: 'cli-smoke', private: true }, null, 2))
  execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], {
    cwd: consumerDir,
    stdio: 'inherit',
  })

  const installedDir = path.join(consumerDir, 'node_modules', '@kasakame', 'cli')
  const installed = JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8'))
  assert.equal(installed.version, expectedVersion, `installed version ${String(installed.version)}, expected ${expectedVersion}`)
  assert.equal(installed.license, 'MIT', `installed license ${String(installed.license)}, expected MIT`)
  assert.ok(fs.existsSync(path.join(installedDir, 'LICENSE')), 'installed package is missing LICENSE')

  const help = execFileSync(path.join(consumerDir, 'node_modules', '.bin', 'kasakame'), ['--help'], {
    cwd: consumerDir,
    encoding: 'utf8',
  })
  assert.match(help, /^Usage: kasakame </, 'kasakame --help did not print the usage')
  console.log(`@kasakame/cli@${expectedVersion} tarball smoke test passed (kasakame --help)`)
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
