import fs from 'node:fs'
import process from 'node:process'

const [packagePath, inputVersion] = process.argv.slice(2)
if (!packagePath || !inputVersion) {
  console.error('usage: node projects/utils/packaging/validate-version.ts <package.json> <version>')
  process.exit(2)
}

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown }
const version = packageJson.version
if (typeof version !== 'string' || version.length === 0) {
  console.error(`${packagePath} has no version`)
  process.exit(1)
}
if (inputVersion !== version) {
  console.error(`input version ${inputVersion} does not match ${packagePath} ${version}`)
  process.exit(1)
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`package version is not semver: ${version}`)
  process.exit(1)
}

const tag = version.includes('-') ? 'next' : 'latest'
const output = `version=${version}\ntag=${tag}\n`
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, output)
} else {
  process.stdout.write(output)
}
console.log(`${packagePath} version ${version} -> ${tag}`)
