import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const rawArgs = process.argv.slice(2)
const expected: string[] = []
const forbidden: string[] = ['node_modules/', 'coverage/', '.tar.gz', '.tgz']
const positional: string[] = []
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index]
  if (arg === '--forbid') {
    const value = rawArgs[index + 1]
    if (value === undefined) {
      console.error('--forbid needs a value')
      process.exit(2)
    }
    forbidden.push(value)
    index += 1
  } else if (arg !== undefined) {
    positional.push(arg)
  }
}

const [tarballArg, packageDirArg, ...expectedArgs] = positional
if (!tarballArg || !packageDirArg) {
  console.error('usage: node projects/utils/release/verify-tarball.ts <tarball> <package-dir> [expected...] [--forbid <text>]')
  process.exit(2)
}

const tarball = path.resolve(tarballArg)
const packageDir = path.resolve(packageDirArg)
expected.push(...expectedArgs)

const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>
for (const field of ['name', 'version', 'description', 'license'] as const) {
  assert.equal(typeof packageJson[field], 'string', `package.json is missing ${field}`)
}
assert.ok(Array.isArray(packageJson.keywords) && packageJson.keywords.length > 0, 'package.json is missing keywords')
assert.ok(packageJson.author, 'package.json is missing author')
assert.equal(typeof packageJson.homepage, 'string', 'package.json is missing homepage')
assert.equal(typeof (packageJson.bugs as { url?: unknown } | undefined)?.url, 'string', 'package.json is missing bugs.url')
assert.equal(typeof packageJson.repository, 'object', 'package.json is missing repository')
assert.equal(typeof (packageJson.repository as { directory?: unknown }).directory, 'string', 'package.json is missing repository.directory')
assert.equal(typeof (packageJson.engines as { node?: unknown } | undefined)?.node, 'string', 'package.json is missing engines.node')
assert.equal((packageJson.publishConfig as { access?: unknown } | undefined)?.access, 'public', 'publishConfig.access must be public')
assert.ok(Array.isArray(packageJson.files) && packageJson.files.length > 0, 'package.json is missing files')

const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file.length > 0 && !file.endsWith('/'))
  .map((file) => file.replace(/^package\//, ''))

for (const required of ['package.json', 'README.md', 'LICENSE']) {
  assert.ok(files.includes(required), `tarball is missing ${required}`)
}
for (const wanted of expected) {
  const matches = wanted.endsWith('/') ? files.some((file) => file.startsWith(wanted)) : files.includes(wanted)
  assert.ok(matches, `tarball is missing ${wanted}`)
}
for (const file of files) {
  for (const text of forbidden) {
    assert.ok(!file.includes(text), `tarball must not contain ${text}: ${file}`)
  }
}

console.log(`tarball verified: ${path.basename(tarball)} (${String(files.length)} files)`)
