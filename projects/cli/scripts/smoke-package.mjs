import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { packSmoke } from '../../../scripts/pack-smoke.mjs'

const packageDir = path.resolve(import.meta.dirname, '..')

packSmoke({
  packageDir,
  consumerName: 'cli-smoke',
  verify: ({ consumerDir, version }) => {
    const help = execFileSync(path.join(consumerDir, 'node_modules', '.bin', 'kasakame'), ['--help'], {
      cwd: consumerDir,
      encoding: 'utf8',
    })
    assert.match(help, /^Usage: kasakame </, 'kasakame --help did not print the usage')
    console.log(`@kasakame/cli@${version} tarball smoke test passed (kasakame --help)`)
  },
})
