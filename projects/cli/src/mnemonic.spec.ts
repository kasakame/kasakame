import { generateAccount, secretKeyToMnemonic } from 'algosdk'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mnemonicSession, resolveMnemonic } from './mnemonic.js'

const ACCOUNT = generateAccount()
const WORDS = secretKeyToMnemonic(ACCOUNT.sk)
const OTHER_ACCOUNT = generateAccount()
const OTHER_WORDS = secretKeyToMnemonic(OTHER_ACCOUNT.sk)

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kasakame-mnemonic-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function writeMnemonic(name: string, words: string): string {
  const file = join(directory, name)
  writeFileSync(file, `${words}\n`)
  return file
}

describe('resolveMnemonic', () => {
  it('reads KASAKAME_MNEMONIC', () => {
    expect(resolveMnemonic(undefined, { KASAKAME_MNEMONIC: WORDS })).toBe(WORDS)
  })

  it('reads a mnemonic file', () => {
    expect(resolveMnemonic(writeMnemonic('test.mnemonic', WORDS), {})).toBe(WORDS)
  })

  it('prefers the file over the environment', () => {
    expect(resolveMnemonic(writeMnemonic('test.mnemonic', WORDS), { KASAKAME_MNEMONIC: OTHER_WORDS })).toBe(WORDS)
  })

  it('falls back to the environment when the file is empty', () => {
    expect(resolveMnemonic(writeMnemonic('empty.mnemonic', ''), { KASAKAME_MNEMONIC: WORDS })).toBe(WORDS)
  })

  it('rejects a missing mnemonic', () => {
    expect(() => resolveMnemonic(undefined, {})).toThrow('Missing mnemonic')
    expect(() => resolveMnemonic(undefined, { KASAKAME_MNEMONIC: '   ' })).toThrow('Missing mnemonic')
  })

  it('rejects an unreadable file', () => {
    expect(() => resolveMnemonic(join(directory, 'missing.mnemonic'), { KASAKAME_MNEMONIC: WORDS })).toThrow('Cannot read mnemonic file')
  })
})

describe('mnemonicSession', () => {
  it('decodes the environment mnemonic', () => {
    const wallet = mnemonicSession(undefined, { KASAKAME_MNEMONIC: WORDS })

    expect(wallet.address).toBe(ACCOUNT.addr.toString())
    expect(typeof wallet.signer).toBe('function')
  })

  it('decodes a mnemonic file', () => {
    expect(mnemonicSession(writeMnemonic('test.mnemonic', WORDS), {}).address).toBe(ACCOUNT.addr.toString())
  })

  it('propagates a missing mnemonic', () => {
    expect(() => mnemonicSession(undefined, {})).toThrow('Missing mnemonic')
  })

  it('rejects an invalid mnemonic', () => {
    const invalid = writeMnemonic('invalid.mnemonic', WORDS.split(' ').slice(0, 24).join(' '))
    expect(() => mnemonicSession(invalid, {})).toThrow('Invalid mnemonic')
  })
})
