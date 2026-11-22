import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Pin the npm package contents and metadata.
 *
 * Runs after `npm run build`; `npm pack --dry-run` triggers the prepack staging
 * step, so this checks the exact tarball the release workflow publishes.
 */

interface PackageManifest {
  name?: string
  version?: string
  description?: string
  license?: string
  keywords?: string[]
  repository?: { directory?: string }
  homepage?: string
  bugs?: { url?: string }
  engines?: { node?: string }
  publishConfig?: { access?: string }
  files?: string[]
  main?: string
}

interface PackFile {
  path: string
}

interface PackInfo {
  name?: string
  version?: string
  files?: Array<string | PackFile>
}

const projectDir = path.resolve(import.meta.dirname, '../..')
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')) as PackageManifest

for (const field of ['name', 'version', 'description', 'license'] as const) {
  const value = packageJson[field]
  assert.ok(typeof value === 'string' && value.length > 0, `package.json is missing ${field}`)
}
assert.equal(packageJson.name, '@kasakame/contracts', 'package name must be @kasakame/contracts')
assert.ok(Array.isArray(packageJson.keywords) && packageJson.keywords.length > 0, 'package.json is missing keywords')
assert.ok(packageJson.repository?.directory === 'projects/contracts', 'repository.directory must be projects/contracts')
assert.ok(packageJson.homepage, 'package.json is missing homepage')
assert.ok(packageJson.bugs?.url, 'package.json is missing bugs.url')
assert.ok(packageJson.engines?.node, 'package.json is missing engines.node')
assert.equal(packageJson.publishConfig?.access, 'public', 'publishConfig.access must be public')
assert.deepEqual(packageJson.files, ['dist'], 'files must be ["dist"]')
assert.equal(packageJson.main, undefined, 'the data package must not declare main')

const packed = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: projectDir, encoding: 'utf8' })
const parsed = JSON.parse(packed) as PackInfo[] | Record<string, PackInfo>
const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
assert.ok(info, 'npm pack returned no package info')
assert.ok(info.name, 'npm pack returned no package name')
assert.ok(info.version, 'npm pack returned no package version')
const files = new Set((info.files ?? []).map((file) => (typeof file === 'string' ? file : file.path)))

for (const required of ['package.json', 'README.md', 'LICENSE']) {
  assert.ok(files.has(required), `tarball is missing ${required}`)
}
for (const kind of ['arc56', 'arc32', 'teal', 'puya']) {
  assert.ok(
    [...files].some((file) => file.startsWith(`dist/${kind}/`)),
    `tarball is missing dist/${kind}`,
  )
}
for (const file of files) {
  assert.ok(!file.endsWith('.ts'), `tarball must not contain TypeScript sources: ${file}`)
  assert.ok(!file.includes('Client'), `tarball must not contain generated clients: ${file}`)
  assert.ok(!file.startsWith('smart_contracts/'), `tarball must not contain contract sources: ${file}`)
  assert.ok(!file.startsWith('deploy/'), `tarball must not contain the deployer: ${file}`)
  assert.ok(!file.startsWith('scripts/'), `tarball must not contain repository scripts: ${file}`)
  assert.ok(!file.startsWith('test/'), `tarball must not contain tests: ${file}`)
}

console.log(`package check passed: ${info.name}@${info.version} (${String(files.size)} files)`)
