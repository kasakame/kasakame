import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)
let packageDirArg: string | undefined
let tag: string | undefined
let tarball: string | undefined
let dryRun = false
let ignoreScripts = false

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--tag') {
    tag = args[index + 1]
    index += 1
  } else if (arg === '--tarball') {
    tarball = args[index + 1]
    index += 1
  } else if (arg === '--dry-run') {
    dryRun = true
  } else if (arg === '--ignore-scripts') {
    ignoreScripts = true
  } else if (arg !== undefined) {
    packageDirArg = arg
  }
}

if (!packageDirArg || !tag) {
  console.error('usage: node projects/utils/release/publish.ts <package-dir> --tag <tag> [--tarball <path>] [--dry-run] [--ignore-scripts]')
  process.exit(2)
}

const packageDir = path.resolve(packageDirArg)
const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
  name?: unknown
  version?: unknown
}
if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
  throw new Error(`${packageDir}/package.json is missing name or version`)
}

const command = ['publish']
if (tarball !== undefined) {
  const tarballPath = path.resolve(tarball)
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`tarball not found: ${tarballPath}`)
  }
  command.push(tarballPath)
}
// A dry run has no OIDC token in the prep job; the real publish signs provenance.
if (!dryRun) {
  command.push('--provenance')
}
command.push('--access', 'public', '--tag', tag)
if (dryRun) {
  command.push('--dry-run')
}
if (ignoreScripts) {
  command.push('--ignore-scripts')
}

const mode = dryRun ? 'dry-run' : 'publish'
console.log(`${mode} ${packageJson.name}@${packageJson.version} with dist-tag ${tag}`)
execFileSync('npm', command, { cwd: packageDir, stdio: 'inherit' })
