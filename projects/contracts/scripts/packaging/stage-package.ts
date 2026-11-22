import fs from 'node:fs'
import path from 'node:path'

/**
 * Stage the compiled contract artifacts into the npm package layout.
 *
 * Runs on `prepack`; the repository build output stays the source of truth and
 * `dist` is generated, never committed.
 */

const projectDir = path.resolve(import.meta.dirname, '../..')
const artifactsDir = path.join(projectDir, 'smart_contracts', 'artifacts')
const distDir = path.join(projectDir, 'dist')

if (!fs.existsSync(artifactsDir)) {
  throw new Error(`no compiled artifacts at ${artifactsDir} - run npm run build first`)
}

const kinds = [
  { name: 'arc56', suffix: '.arc56.json' },
  { name: 'arc32', suffix: '.arc32.json' },
  { name: 'teal', suffix: '.teal' },
  { name: 'puya', suffix: '.puya.map' },
]

fs.rmSync(distDir, { recursive: true, force: true })

let staged = 0
for (const entry of fs.readdirSync(artifactsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const appDir = path.join(artifactsDir, entry.name)
  for (const file of fs.readdirSync(appDir, { withFileTypes: true })) {
    if (!file.isFile()) continue
    const kind = kinds.find((candidate) => file.name.endsWith(candidate.suffix))
    if (kind === undefined) continue
    const targetDir = path.join(distDir, kind.name, entry.name)
    fs.mkdirSync(targetDir, { recursive: true })
    fs.copyFileSync(path.join(appDir, file.name), path.join(targetDir, file.name))
    staged += 1
  }
}

if (staged === 0) {
  throw new Error(`no packageable artifacts found under ${artifactsDir}`)
}

console.error(`staged ${String(staged)} artifacts into ${path.relative(projectDir, distDir)}`)
