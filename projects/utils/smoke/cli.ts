import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const bin = process.platform === 'win32' ? 'kasakame.cmd' : 'kasakame'
const help = execFileSync(`node_modules/.bin/${bin}`, ['--help'], { encoding: 'utf8' })
assert.match(help, /^Usage: kasakame </, 'kasakame --help did not print the usage')
console.log('@kasakame/cli smoke passed (kasakame --help)')
