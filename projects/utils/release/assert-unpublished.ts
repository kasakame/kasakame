import { spawnSync } from 'node:child_process'
import process from 'node:process'

const [packageName, version] = process.argv.slice(2)
if (!packageName || !version) {
  console.error('usage: node projects/utils/release/assert-unpublished.ts <package> <version>')
  process.exit(2)
}

const result = spawnSync('npm', ['view', `${packageName}@${version}`, 'version'], { encoding: 'utf8' })
if (result.error !== undefined || result.status === null) {
  console.error(`could not query npm for ${packageName}@${version}: ${result.error?.message ?? 'no exit status'}`)
  process.exit(1)
}
if (result.status === 0) {
  console.error(`${packageName}@${version} is already published`)
  process.exit(1)
}
// Only a missing version (E404) means free; network, auth, and registry errors must stop the release.
const output = `${result.stdout}${result.stderr}`
if (!/E404|404 Not Found/.test(output)) {
  console.error(`could not verify ${packageName}@${version} is unpublished:`)
  console.error(output.trim())
  process.exit(1)
}
console.log(`${packageName}@${version} is free`)
