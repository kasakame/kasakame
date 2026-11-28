import algosdk from 'algosdk'
import { describe, expect, it } from 'vitest'
import type { CampaignHeader } from './index.js'
import { campaignFromHeader, getCampaignStatus, toCampaignViewModel } from './index.js'

const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'

function tealUint(value: bigint): algosdk.indexerModels.TealValue {
  return new algosdk.indexerModels.TealValue({ bytes: new Uint8Array(), type: 2, uint: value })
}

function tealBytes(value: Uint8Array): algosdk.indexerModels.TealValue {
  return new algosdk.indexerModels.TealValue({ bytes: value, type: 1, uint: 0n })
}

function kv(key: string, value: algosdk.indexerModels.TealValue): algosdk.indexerModels.TealKeyValue {
  return new algosdk.indexerModels.TealKeyValue({ key: new TextEncoder().encode(key), value })
}

function appParams(globalState: algosdk.indexerModels.TealKeyValue[]): algosdk.indexerModels.ApplicationParams {
  return new algosdk.indexerModels.ApplicationParams({
    approvalProgram: new Uint8Array(),
    clearStateProgram: new Uint8Array(),
    globalState,
  })
}

function campaignApp(overrides: { status?: bigint; raised?: bigint } = {}): algosdk.indexerModels.Application {
  const globalState = [
    kv('creator', tealBytes(algosdk.decodeAddress(ZERO_ADDRESS).publicKey)),
    kv('title', tealBytes(new TextEncoder().encode('My first novel'))),
    kv('metadataUri', tealBytes(new TextEncoder().encode('ipfs://QmExample'))),
    kv('goal', tealUint(10_000_000n)),
    kv('deadline', tealUint(2_000n)),
    kv('raised', tealUint(overrides.raised ?? 5_000_000n)),
    kv('status', tealUint(overrides.status ?? 0n)),
    kv('root', tealBytes(new Uint8Array(32))),
    kv('n', tealUint(0n)),
  ]
  return new algosdk.indexerModels.Application({ id: 42n, params: appParams(globalState) })
}

const header = (overrides: Partial<CampaignHeader> = {}): CampaignHeader => ({
  id: 42n,
  creator: 'SENDER',
  title: 'T',
  metadataUri: 'M',
  goalMicroAlgos: 10n,
  deadlineSeconds: 1_000n,
  raisedMicroAlgos: 0n,
  status: 'open',
  deleted: false,
  ...overrides,
})

describe('getCampaignStatus', () => {
  it('returns open before the deadline', () => {
    expect(getCampaignStatus(header(), 500n)).toBe('open')
  })

  it('returns failed when past deadline and goal not met', () => {
    expect(getCampaignStatus(header({ deadlineSeconds: 500n, raisedMicroAlgos: 5n }), 1_000n)).toBe('failed')
  })

  it('returns successful when past deadline and goal met', () => {
    expect(getCampaignStatus(header({ deadlineSeconds: 500n, raisedMicroAlgos: 10n }), 1_000n)).toBe('successful')
  })

  it('returns successful when claimed before the deadline', () => {
    expect(getCampaignStatus(header({ status: 'claimed' }), 500n)).toBe('successful')
  })

  it('returns successful when claimed after the deadline', () => {
    expect(getCampaignStatus(header({ status: 'claimed', deadlineSeconds: 500n }), 1_000n)).toBe('successful')
  })
})

describe('campaignFromHeader', () => {
  it('carries the header fields and derives the display status', () => {
    expect(campaignFromHeader(header({ status: 'claimed', deleted: true }), 500n)).toEqual({
      id: 42n,
      creator: 'SENDER',
      title: 'T',
      metadataUri: 'M',
      goalMicroAlgos: 10n,
      raisedMicroAlgos: 0n,
      deadlineSeconds: 1_000n,
      status: 'successful',
      claimed: true,
      deleted: true,
    })
  })

  it('does not mark a failed header as claimed', () => {
    expect(campaignFromHeader(header({ status: 'failed' }), 2_000n).claimed).toBe(false)
  })
})

describe('toCampaignViewModel', () => {
  it('maps an Application to a view model', () => {
    const vm = toCampaignViewModel(campaignApp({ raised: 10_000_000n }), 3_000n, 250_000n)
    expect(vm.id).toBe(42n)
    expect(vm.creator).toBe(ZERO_ADDRESS)
    expect(vm.title).toBe('My first novel')
    expect(vm.metadataUri).toBe('ipfs://QmExample')
    expect(vm.goalMicroAlgos).toBe(10_000_000n)
    expect(vm.raisedMicroAlgos).toBe(10_000_000n)
    expect(vm.deadlineSeconds).toBe(2_000n)
    expect(vm.status).toBe('successful')
    expect(vm.myPledgeMicroAlgos).toBe(250_000n)
  })

  it('defaults missing goal/raised to zero', () => {
    const app = new algosdk.indexerModels.Application({
      id: 7n,
      params: appParams([kv('status', tealUint(0n))]),
    })
    const vm = toCampaignViewModel(app, 1_000n)
    expect(vm.goalMicroAlgos).toBe(0n)
    expect(vm.raisedMicroAlgos).toBe(0n)
  })

  it('defaults missing deadline, status, and creator', () => {
    const app = new algosdk.indexerModels.Application({
      id: 7n,
      params: appParams([kv('goal', tealUint(10n)), kv('raised', tealUint(5n))]),
    })
    const vm = toCampaignViewModel(app, 1_000n)
    expect(vm.deadlineSeconds).toBe(0n)
    expect(vm.creator).toBe('')
    // deadline (0) <= now (1000) and raised < goal -> failed
    expect(vm.status).toBe('failed')
  })

  it('maps stored status 1 (failed) to failed', () => {
    const app = new algosdk.indexerModels.Application({
      id: 7n,
      params: appParams([
        kv('goal', tealUint(10n)),
        kv('raised', tealUint(5n)),
        kv('deadline', tealUint(500n)),
        kv('status', tealUint(1n)),
      ]),
    })
    const vm = toCampaignViewModel(app, 1_000n)
    expect(vm.status).toBe('failed')
    expect(vm.claimed).toBe(false)
  })

  it('maps stored status 2 (claimed) to successful', () => {
    const app = new algosdk.indexerModels.Application({
      id: 7n,
      params: appParams([
        kv('goal', tealUint(10n)),
        kv('raised', tealUint(5n)),
        kv('deadline', tealUint(2_000n)),
        kv('status', tealUint(2n)),
      ]),
    })
    const vm = toCampaignViewModel(app, 1_000n)
    expect(vm.status).toBe('successful')
    expect(vm.claimed).toBe(true)
  })

  it('defaults missing title and metadata uri to empty string', () => {
    const app = new algosdk.indexerModels.Application({
      id: 7n,
      params: appParams([kv('goal', tealUint(10n)), kv('raised', tealUint(5n))]),
    })
    const vm = toCampaignViewModel(app, 1_000n)
    expect(vm.title).toBe('')
    expect(vm.metadataUri).toBe('')
  })
})
