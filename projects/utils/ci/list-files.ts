import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const mode = process.argv[2]
if (mode !== 'lint' && mode !== 'format' && mode !== 'types') {
  console.error('usage: node projects/utils/ci/list-files.ts <lint|format|types>')
  process.exit(2)
}

// Local runs stay quiet; CI logs get the exact file inventory.
if (!process.env.CI) {
  process.exit(0)
}

const cwd = process.cwd()
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
const relativeCwd = path.relative(root, cwd).split(path.sep).join('/')
const tracked = execFileSync('git', ['ls-files', '--', relativeCwd], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((file) => file.length > 0)

const extensions = mode === 'format' ? undefined : mode === 'lint' ? ['.ts', '.tsx', '.js', '.mjs', '.cjs'] : ['.ts', '.tsx']

const files = tracked
  .filter((file) => extensions === undefined || extensions.some((extension) => file.endsWith(extension)))
  .filter((file) => !file.endsWith('package-lock.json'))
  .filter((file) => !file.endsWith('.tgz'))
  .sort()

console.log(`${mode} files (${String(files.length)}):`)
for (const file of files) {
  console.log(`  ${file}`)
}
