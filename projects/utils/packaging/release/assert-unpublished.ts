import { execFileSync } from 'node:child_process'
import process from 'node:process'

const [packageName, version] = process.argv.slice(2)
if (!packageName || !version) {
  console.error('usage: node projects/utils/packaging/release/assert-unpublished.ts <package> <version>')
  process.exit(2)
}

try {
  execFileSync('npm', ['view', `${packageName}@${version}`, 'version'], { stdio: 'ignore' })
  console.error(`${packageName}@${version} is already published`)
  process.exit(1)
} catch {
  console.log(`${packageName}@${version} is free`)
}
