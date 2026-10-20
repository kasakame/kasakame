import fs from 'node:fs'

const [packagePath, inputVersion] = process.argv.slice(2)
if (!packagePath || !inputVersion) {
  console.error('usage: node .github/scripts/check-release-version.mjs <package.json> <version>')
  process.exit(2)
}

const { version } = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
if (typeof version !== 'string') {
  console.error(`${packagePath} has no version`)
  process.exit(1)
}
if (inputVersion !== version) {
  console.error(`input version ${inputVersion} does not match ${packagePath} ${version}`)
  process.exit(1)
}
console.log(`${packagePath} version ${version} matches the dispatch input`)
