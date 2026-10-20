import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sdkDir = path.resolve(import.meta.dirname, '..')
const specsVersion = JSON.parse(fs.readFileSync(path.join(sdkDir, 'package.json'), 'utf8')).config?.specsVersion
if (typeof specsVersion !== 'string' || specsVersion.length === 0) {
  throw new Error('package.json config.specsVersion is missing - add the pinned specs version')
}
const generatedDir = path.join(sdkDir, 'src', 'generated')
const localArtifactsDir = path.resolve(sdkDir, '../contracts/smart_contracts/artifacts')
const generatorBin = path.join(
  sdkDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'algokit-client-generator.cmd' : 'algokit-client-generator',
)

function findSpecs(root) {
  const specs = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) specs.push(...findSpecs(full))
    else if (entry.name.endsWith('.arc56.json')) specs.push(full)
  }
  return specs.sort()
}

function releaseSpecsDir() {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' })
  } catch {
    throw new Error('gh CLI not found - install it and run `gh auth login`, or set SDK_SPECS=local')
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasakame-specs-'))
  try {
    execFileSync('gh', ['release', 'download', `specs-v${String(specsVersion)}`, '--pattern', 'arc56.tar.gz', '--dir', dir], {
      stdio: 'inherit',
    })
    execFileSync('tar', ['-xzf', path.join(dir, 'arc56.tar.gz'), '-C', dir], { stdio: 'inherit' })
    return dir
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

const source = process.env.SDK_SPECS ?? 'release'
if (source !== 'release' && source !== 'local') {
  throw new Error(`SDK_SPECS must be "release" or "local" (got: ${source})`)
}
if (!fs.existsSync(generatorBin)) {
  throw new Error(`algokit-client-generator is not installed at ${generatorBin} - run npm install`)
}

let specsDir
let cleanup = () => {}
if (source === 'local') {
  if (!fs.existsSync(localArtifactsDir)) {
    throw new Error(
      `no local contract artifacts at ${localArtifactsDir} - build the contracts first (npm run build in projects/contracts), or use SDK_SPECS=release`,
    )
  }
  specsDir = localArtifactsDir
} else {
  specsDir = releaseSpecsDir()
  cleanup = () => {
    fs.rmSync(specsDir, { recursive: true, force: true })
  }
}

try {
  const specs = findSpecs(specsDir)
  if (specs.length === 0) throw new Error(`no *.arc56.json specs found under ${specsDir}`)

  fs.rmSync(generatedDir, { recursive: true, force: true })
  fs.mkdirSync(generatedDir, { recursive: true })
  for (const spec of specs) {
    const name = path.basename(spec, '.arc56.json')
    const output = path.join(generatedDir, `${name}Client.ts`)
    execFileSync(generatorBin, ['generate', '--application', spec, '--output', output], { stdio: 'inherit' })
    // `exclude` doesn't remove imported files from the program, so the generated client opts out per file.
    fs.writeFileSync(output, `// @ts-nocheck\n${fs.readFileSync(output, 'utf8')}`)
    console.log(`generated ${path.relative(sdkDir, output)} from ${path.relative(specsDir, spec)}`)
  }
} finally {
  cleanup()
}
