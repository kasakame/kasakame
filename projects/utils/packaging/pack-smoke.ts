import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const rawArgs = process.argv.slice(2)
let tarballArg: string | undefined
const positional: string[] = []
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index]
  if (arg === '--tarball') {
    tarballArg = rawArgs[index + 1]
    index += 1
  } else if (arg !== undefined) {
    positional.push(arg)
  }
}

const [packageDirArg, smokeScriptArg] = positional
if (!packageDirArg || !smokeScriptArg) {
  console.error('usage: node projects/utils/packaging/pack-smoke.ts <package-dir> <smoke-script> [--tarball <path>]')
  process.exit(2)
}

const packageDir = path.resolve(packageDirArg)
const smokeScript = path.resolve(smokeScriptArg)
const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
  name?: unknown
  version?: unknown
}
const packageName = packageJson.name
const packageVersion = packageJson.version
if (typeof packageName !== 'string' || typeof packageVersion !== 'string') {
  console.error(`${packageDir}/package.json is missing name or version`)
  process.exit(1)
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasakame-pack-smoke-'))
const packDir = path.join(tempDir, 'package')
const consumerDir = path.join(tempDir, 'consumer')
fs.mkdirSync(packDir)
fs.mkdirSync(consumerDir)

try {
  let tarball = tarballArg === undefined ? undefined : path.resolve(tarballArg)
  if (tarball === undefined) {
    execFileSync('npm', ['pack', '--pack-destination', packDir], { cwd: packageDir, stdio: 'inherit' })
    const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith('.tgz'))
    assert.equal(tarballs.length, 1, `expected one tarball in ${packDir}`)
    const [packed] = tarballs
    assert.ok(packed, 'packed tarball is missing')
    tarball = path.join(packDir, packed)
  }
  assert.ok(fs.existsSync(tarball), `tarball is missing: ${tarball}`)

  console.log(`tarball contents:\n${execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })}`)

  fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({ name: 'pack-smoke', private: true, type: 'module' }, null, 2))
  execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: consumerDir, stdio: 'inherit' })

  const installedDir = path.join(consumerDir, 'node_modules', ...packageName.split('/'))
  const installed = JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  assert.equal(installed.name, packageName, `installed name ${String(installed.name)}, expected ${packageName}`)
  assert.equal(installed.version, packageVersion, `installed version ${String(installed.version)}, expected ${packageVersion}`)
  assert.ok(fs.existsSync(path.join(installedDir, 'README.md')), 'installed package is missing README')
  assert.ok(fs.existsSync(path.join(installedDir, 'LICENSE')), 'installed package is missing LICENSE')

  const copiedSmoke = path.join(consumerDir, 'smoke-package.ts')
  fs.copyFileSync(smokeScript, copiedSmoke)
  execFileSync(process.execPath, [copiedSmoke], {
    cwd: consumerDir,
    stdio: 'inherit',
    env: { ...process.env, PACKAGE_NAME: packageName, PACKAGE_VERSION: packageVersion },
  })

  console.log(`${packageName}@${packageVersion} pack smoke passed`)
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
