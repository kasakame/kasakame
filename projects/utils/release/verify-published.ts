import { execFileSync } from 'node:child_process'
import process from 'node:process'

const [name, version] = process.argv.slice(2)
if (!name || !version) {
  console.error('usage: node projects/utils/release/verify-published.ts <package> <version>')
  process.exit(2)
}

const attempts = 40
const delayMs = 15_000
const target = `${name}@${version}`

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    execFileSync('npm', ['view', target, 'version'], { stdio: 'ignore' })
    console.log(`${target} is visible (attempt ${String(attempt)}/${String(attempts)})`)
    process.exit(0)
  } catch {
    console.log(`${target} not visible yet (attempt ${String(attempt)}/${String(attempts)}); waiting`)
  }
  if (attempt < attempts) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
}

console.error(`${target} did not appear in the registry after 10 minutes`)
process.exit(1)
