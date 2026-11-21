import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Pack a project, install the tarball in a clean consumer, and run its package-specific verification.
 *
 * @param {object} options
 * @param {string} options.packageDir The package directory to pack.
 * @param {string} options.consumerName The clean consumer package name.
 * @param {(context: { consumerDir: string, installedDir: string, packageJson: Record<string, unknown>, version: string }) => void} options.verify Package-specific checks.
 */
export function packSmoke({ packageDir, consumerName, verify }) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  const version = packageJson.version
  if (typeof version !== 'string') {
    throw new Error('package.json version is missing')
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `kasakame-${consumerName}-`))
  const packDir = path.join(tempDir, 'package')
  const consumerDir = path.join(tempDir, 'consumer')
  fs.mkdirSync(packDir)
  fs.mkdirSync(consumerDir)

  try {
    execFileSync('npm', ['pack', '--pack-destination', packDir], { cwd: packageDir, stdio: 'inherit' })
    const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith('.tgz'))
    assert.equal(tarballs.length, 1, `expected one tarball in ${packDir}`)
    const tarball = path.join(packDir, tarballs[0])

    fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({ name: consumerName, private: true, type: 'module' }, null, 2))
    execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], {
      cwd: consumerDir,
      stdio: 'inherit',
    })

    const installedDir = path.join(consumerDir, 'node_modules', packageJson.name)
    const installed = JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8'))
    assert.equal(installed.version, version, `installed version ${String(installed.version)}, expected ${version}`)
    assert.equal(installed.license, 'MIT', `installed license ${String(installed.license)}, expected MIT`)
    assert.ok(fs.existsSync(path.join(installedDir, 'LICENSE')), 'installed package is missing LICENSE')

    verify({ consumerDir, installedDir, packageJson, version })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
