import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve('node_modules/@kasakame/contracts')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: unknown }
assert.equal(packageJson.name, '@kasakame/contracts')
for (const kind of ['arc56', 'arc32', 'teal', 'puya']) {
  const dir = path.join(root, 'dist', kind)
  assert.ok(fs.existsSync(dir), `missing dist/${kind}`)
  assert.ok(fs.readdirSync(dir).length > 0, `empty dist/${kind}`)
}
const [app] = fs.readdirSync(path.join(root, 'dist', 'arc56')).sort()
assert.ok(app, 'no ARC-56 applications')
const appDir = path.join(root, 'dist', 'arc56', app)
const [specFile] = fs.readdirSync(appDir).sort()
assert.ok(specFile, `no ARC-56 spec in ${appDir}`)
const spec = JSON.parse(fs.readFileSync(path.join(appDir, specFile), 'utf8')) as { name?: unknown; byteCode?: { approval?: unknown } }
assert.ok(spec.name && spec.byteCode?.approval, 'invalid ARC-56 spec')
console.log('contracts package smoke passed')
