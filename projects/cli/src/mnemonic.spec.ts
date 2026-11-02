import { XHDWalletAPI } from '@algorandfoundation/xhd-wallet-api'
import {
  decodeAddress,
  decodeSignedTransaction,
  generateAccount,
  makePaymentTxnWithSuggestedParamsFromObject,
  secretKeyToMnemonic,
} from 'algosdk'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mnemonicSession, resolveMnemonic } from './mnemonic.js'

const ACCOUNT = generateAccount()
const WORDS = secretKeyToMnemonic(ACCOUNT.sk)
const OTHER_ACCOUNT = generateAccount()
const OTHER_WORDS = secretKeyToMnemonic(OTHER_ACCOUNT.sk)

// ARC-52 reference vector: m'/44'/283'/0'/0/0, Peikert mode.
const UNIVERSAL_WORDS =
  'salon zoo engage submit smile frost later decide wing sight chaos renew lizard rely canal coral scene hobby scare step bus leaf tobacco slice'
const UNIVERSAL_ADDRESS = 'PPNHVQJGE6ZMEWPR35UHLUYMCCZV6VNTHLJMZDVCONXKUPV47K4WGQJWGI'

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
  it('decodes the environment mnemonic', async () => {
    const wallet = await mnemonicSession(undefined, { KASAKAME_MNEMONIC: WORDS })

    expect(wallet.address).toBe(ACCOUNT.addr.toString())
    expect(typeof wallet.signer).toBe('function')
  })

  it('decodes a mnemonic file', async () => {
    expect((await mnemonicSession(writeMnemonic('test.mnemonic', WORDS), {})).address).toBe(ACCOUNT.addr.toString())
  })

  it('accepts an address the Algo25 phrase controls', async () => {
    expect((await mnemonicSession(undefined, { KASAKAME_MNEMONIC: WORDS }, ACCOUNT.addr.toString())).address).toBe(ACCOUNT.addr.toString())
  })

  it('rejects an address the Algo25 phrase does not control', async () => {
    await expect(mnemonicSession(undefined, { KASAKAME_MNEMONIC: WORDS }, OTHER_ACCOUNT.addr.toString())).rejects.toThrow(
      `The mnemonic does not control ${OTHER_ACCOUNT.addr.toString()}`,
    )
  })

  it('propagates a missing mnemonic', async () => {
    await expect(mnemonicSession(undefined, {})).rejects.toThrow('Missing mnemonic')
  })

  it('rejects an unknown phrase length', async () => {
    const invalid = writeMnemonic('invalid.mnemonic', WORDS.split(' ').slice(0, 12).join(' '))
    await expect(mnemonicSession(invalid, {})).rejects.toThrow('Invalid mnemonic')
  })

  it('requires an address for a 24-word phrase', async () => {
    await expect(mnemonicSession(undefined, { KASAKAME_MNEMONIC: UNIVERSAL_WORDS })).rejects.toThrow(
      'A 24-word Pera Universal Wallet phrase can derive several accounts; pass --address',
    )
  })

  it('rejects a malformed address for a 24-word phrase', async () => {
    await expect(mnemonicSession(undefined, { KASAKAME_MNEMONIC: UNIVERSAL_WORDS }, 'ADDRESS')).rejects.toThrow('Invalid address: ADDRESS')
  })

  it('derives and signs for the ARC-52 reference vector', async () => {
    const wallet = await mnemonicSession(undefined, { KASAKAME_MNEMONIC: UNIVERSAL_WORDS }, UNIVERSAL_ADDRESS)
    expect(wallet.address).toBe(UNIVERSAL_ADDRESS)

    const txn = makePaymentTxnWithSuggestedParamsFromObject({
      sender: UNIVERSAL_ADDRESS,
      receiver: UNIVERSAL_ADDRESS,
      amount: 0,
      suggestedParams: {
        fee: 0,
        minFee: 1000,
        flatFee: true,
        firstValid: 1,
        lastValid: 1000,
        genesisHash: new Uint8Array(32),
        genesisID: 'testnet-v1.0',
      },
    })
    const [signed] = await wallet.signer([txn], [0])
    expect(signed).toBeDefined()
    const decoded = decodeSignedTransaction(signed as Uint8Array)
    expect(decoded.sig).toBeDefined()
    expect(
      await new XHDWalletAPI().verifyWithPublicKey(
        decoded.sig as Uint8Array,
        decoded.txn.bytesToSign(),
        decodeAddress(UNIVERSAL_ADDRESS).publicKey,
      ),
    ).toBe(true)
  })

  it('rejects an address the 24-word phrase does not control', async () => {
    await expect(mnemonicSession(undefined, { KASAKAME_MNEMONIC: UNIVERSAL_WORDS }, OTHER_ACCOUNT.addr.toString())).rejects.toThrow(
      `No account in the 24-word mnemonic matches ${OTHER_ACCOUNT.addr.toString()}`,
    )
  })
})
