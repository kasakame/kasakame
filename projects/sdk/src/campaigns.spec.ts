import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeGlobalState, deriveStatus, enumerateCampaigns, isCampaignApp, toCampaignViewModel } from './campaigns.js'

vi.mock('./chain.js', () => ({
  getSdkConfig: () => ({
    algorand: {
      client: {
        indexer: {
          searchForApplicationBoxes: (...args: unknown[]) => searchForApplicationBoxesMock(...args),
        },
      },
    },
    factoryAppId: factoryAppIdMock(),
    vaultAppId: 2002n,
  }),
}))

const { factoryAppIdMock, searchForApplicationBoxesMock } = vi.hoisted(() => ({
  factoryAppIdMock: vi.fn(() => 1001n),
  searchForApplicationBoxesMock: vi.fn(),
}))

// Indexer `searchForApplicationBoxes` returns a limit/nextToken/do chain, mocked per app id:
// 1001n => factory registration boxes, 2002n => vault per-campaign boxes.
let factoryBoxesValue: { boxes: { name: Uint8Array }[]; nextToken: string | undefined }
let vaultBoxesValue: { boxes: { name: Uint8Array }[]; nextToken: string | undefined }
const factoryLimitMock = vi.fn(() => factoryChain)
const factoryNextTokenMock = vi.fn(() => factoryChain)
const factoryDoMock = vi.fn(() => Promise.resolve(factoryBoxesValue))
const factoryChain = { limit: factoryLimitMock, nextToken: factoryNextTokenMock, do: factoryDoMock }
const vaultLimitMock = vi.fn(() => vaultChain)
const vaultNextTokenMock = vi.fn(() => vaultChain)
const vaultDoMock = vi.fn(() => Promise.resolve(vaultBoxesValue))
const vaultChain = { limit: vaultLimitMock, nextToken: vaultNextTokenMock, do: vaultDoMock }
const emptyChain = {
  limit: () => emptyChain,
  nextToken: () => emptyChain,
  do: () => Promise.resolve({ boxes: [], nextToken: undefined }),
}
searchForApplicationBoxesMock.mockImplementation((appId: bigint) => {
  if (appId === 1001n) return factoryChain
  if (appId === 2002n) return vaultChain
  return emptyChain
})

function boxName(appId: bigint, prefix: number): Uint8Array {
  const bytes = new Uint8Array(9)
  bytes[0] = prefix
  let remaining = appId
  for (let i = 8; i >= 1; i--) {
    bytes[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return bytes
}

const REGISTRATION_BOX_PREFIX = 0x72
const VAULT_BOX_PREFIX = 0x63

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

describe('decodeGlobalState', () => {
  it('decodes creator, title, metadata uri, goal, deadline, raised, and status', () => {
    const app = campaignApp()
    const state = decodeGlobalState(app)
    expect(state.creator).toBe(ZERO_ADDRESS)
    expect(state.title).toBe('My first novel')
    expect(state.metadataUri).toBe('ipfs://QmExample')
    expect(state.goal).toBe(10_000_000n)
    expect(state.deadline).toBe(2_000n)
    expect(state.raised).toBe(5_000_000n)
    expect(state.status).toBe(0n)
  })

  it('ignores unknown keys', () => {
    const app = new algosdk.indexerModels.Application({
      id: 1n,
      params: appParams([kv('other', tealUint(7n))]),
    })
    const state = decodeGlobalState(app)
    expect(state).toEqual({})
  })

  it('returns an empty object when global state is absent', () => {
    const app = new algosdk.indexerModels.Application({
      id: 1n,
      params: new algosdk.indexerModels.ApplicationParams({
        approvalProgram: new Uint8Array(),
        clearStateProgram: new Uint8Array(),
      }),
    })
    expect(decodeGlobalState(app)).toEqual({})
  })
})

describe('isCampaignApp', () => {
  it('returns true when all known keys are present', () => {
    expect(isCampaignApp(campaignApp())).toBe(true)
  })

  it('returns false when the root key is missing', () => {
    const app = new algosdk.indexerModels.Application({
      id: 1n,
      params: appParams([
        kv('creator', tealBytes(algosdk.decodeAddress(ZERO_ADDRESS).publicKey)),
        kv('title', tealBytes(new TextEncoder().encode('t'))),
        kv('metadataUri', tealBytes(new TextEncoder().encode('m'))),
        kv('goal', tealUint(1n)),
        kv('deadline', tealUint(2n)),
        kv('raised', tealUint(3n)),
        kv('status', tealUint(0n)),
      ]),
    })
    expect(isCampaignApp(app)).toBe(false)
  })

  it('returns false for unrelated apps', () => {
    const app = new algosdk.indexerModels.Application({
      id: 1n,
      params: appParams([kv('something-else', tealUint(1n))]),
    })
    expect(isCampaignApp(app)).toBe(false)
  })

  it('returns false when global state is absent', () => {
    const app = new algosdk.indexerModels.Application({
      id: 1n,
      params: new algosdk.indexerModels.ApplicationParams({
        approvalProgram: new Uint8Array(),
        clearStateProgram: new Uint8Array(),
      }),
    })
    expect(isCampaignApp(app)).toBe(false)
  })
})

describe('deriveStatus', () => {
  it('returns claimed when status uint is 2', () => {
    expect(deriveStatus(10n, 10n, 1_000n, 2n, 2_000n)).toBe('claimed')
  })

  it('returns failed when status uint is 1', () => {
    expect(deriveStatus(10n, 10n, 1_000n, 1n, 2_000n)).toBe('failed')
  })

  it('returns funded when deadline passed and goal met', () => {
    expect(deriveStatus(10n, 10n, 1_000n, 0n, 2_000n)).toBe('funded')
  })

  it('returns failed when deadline passed but goal not met (derived, pre-refund)', () => {
    expect(deriveStatus(10n, 5n, 1_000n, 0n, 2_000n)).toBe('failed')
  })

  it('returns open while before the deadline', () => {
    expect(deriveStatus(10n, 10n, 3_000n, 0n, 2_000n)).toBe('open')
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
    expect(vm.status).toBe('funded')
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

describe('enumerateCampaigns', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    factoryAppIdMock.mockReturnValue(1001n)
    factoryBoxesValue = { boxes: [], nextToken: undefined }
    vaultBoxesValue = { boxes: [], nextToken: undefined }
    searchForApplicationBoxesMock.mockImplementation((appId: bigint) => {
      if (appId === 1001n) return factoryChain
      if (appId === 2002n) return vaultChain
      return emptyChain
    })
    factoryLimitMock.mockImplementation(() => factoryChain)
    factoryNextTokenMock.mockImplementation(() => factoryChain)
    factoryDoMock.mockImplementation(() => Promise.resolve(factoryBoxesValue))
    vaultLimitMock.mockImplementation(() => vaultChain)
    vaultNextTokenMock.mockImplementation(() => vaultChain)
    vaultDoMock.mockImplementation(() => Promise.resolve(vaultBoxesValue))
  })

  it('lists factory-registered campaign ids', async () => {
    factoryBoxesValue = {
      boxes: [{ name: boxName(7n, REGISTRATION_BOX_PREFIX) }, { name: boxName(42n, REGISTRATION_BOX_PREFIX) }],
      nextToken: undefined,
    }
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set([7n, 42n]))
    expect(searchForApplicationBoxesMock).toHaveBeenCalledWith(1001n)
    expect(searchForApplicationBoxesMock).toHaveBeenCalledWith(2002n)
    expect(factoryLimitMock).toHaveBeenCalledWith(1000)
  })

  it('includes vault-boxed campaigns not registered with the factory', async () => {
    factoryBoxesValue = { boxes: [{ name: boxName(7n, REGISTRATION_BOX_PREFIX) }], nextToken: undefined }
    vaultBoxesValue = { boxes: [{ name: boxName(9n, VAULT_BOX_PREFIX) }], nextToken: undefined }
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set([7n, 9n]))
  })

  it('dedupes campaigns present in both the factory and the vault', async () => {
    factoryBoxesValue = { boxes: [{ name: boxName(7n, REGISTRATION_BOX_PREFIX) }], nextToken: undefined }
    vaultBoxesValue = { boxes: [{ name: boxName(7n, VAULT_BOX_PREFIX) }], nextToken: undefined }
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set([7n]))
  })

  it('returns an empty set when neither source lists campaigns', async () => {
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set())
  })

  it('skips malformed box names from either source', async () => {
    factoryBoxesValue = {
      boxes: [
        { name: boxName(7n, REGISTRATION_BOX_PREFIX) },
        { name: new Uint8Array([0x72, 0, 0, 0, 0, 0, 0, 0]) }, // 8 bytes: wrong length
        { name: new Uint8Array([0x00, 0, 0, 0, 0, 0, 0, 0, 7]) }, // 9 bytes: wrong prefix
      ],
      nextToken: undefined,
    }
    vaultBoxesValue = {
      boxes: [
        { name: boxName(9n, VAULT_BOX_PREFIX) },
        { name: new Uint8Array([0x63, 0, 0, 0, 0, 0, 0, 0]) }, // 8 bytes: wrong length
      ],
      nextToken: undefined,
    }
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set([7n, 9n]))
  })

  it('skips the factory when no factory is configured', async () => {
    factoryAppIdMock.mockReturnValue(0n)
    vaultBoxesValue = { boxes: [{ name: boxName(9n, VAULT_BOX_PREFIX) }], nextToken: undefined }
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set([9n]))
    expect(searchForApplicationBoxesMock).not.toHaveBeenCalledWith(1001n)
    expect(searchForApplicationBoxesMock).toHaveBeenCalledWith(2002n)
  })

  it('paginates both box searches across multiple pages', async () => {
    factoryDoMock
      .mockResolvedValueOnce({ boxes: [{ name: boxName(7n, REGISTRATION_BOX_PREFIX) }], nextToken: 't' })
      .mockResolvedValueOnce({ boxes: [{ name: boxName(42n, REGISTRATION_BOX_PREFIX) }], nextToken: undefined })
    vaultDoMock
      .mockResolvedValueOnce({ boxes: [], nextToken: 'vt' })
      .mockResolvedValueOnce({ boxes: [{ name: boxName(9n, VAULT_BOX_PREFIX) }], nextToken: undefined })
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set([7n, 42n, 9n]))
    expect(factoryNextTokenMock).toHaveBeenCalledWith('t')
    expect(vaultNextTokenMock).toHaveBeenCalledWith('vt')
  })
})
