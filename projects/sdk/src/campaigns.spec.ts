import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CampaignHeader } from './campaigns.js'
import {
  decodeGlobalState,
  enumerateCampaigns,
  fetchCampaignHeader,
  getCampaignStatus,
  isCampaignApp,
  toCampaignViewModel,
} from './campaigns.js'

vi.mock('./chain.js', () => ({
  getSdkConfig: () => ({
    algorand: {
      client: {
        indexer: {
          searchForApplicationBoxes: (...args: unknown[]) => searchForApplicationBoxesMock(...args),
          lookupApplications: (...args: unknown[]) => lookupApplicationsMock(...args),
          lookupBlock: (...args: unknown[]) => lookupBlockMock(...args),
        },
      },
    },
    factoryAppId: factoryAppIdMock(),
    vaultAppId: 2002n,
  }),
}))

const { factoryAppIdMock, searchForApplicationBoxesMock, lookupApplicationsMock, lookupBlockMock } = vi.hoisted(() => ({
  factoryAppIdMock: vi.fn(() => 1001n),
  searchForApplicationBoxesMock: vi.fn(),
  lookupApplicationsMock: vi.fn(),
  lookupBlockMock: vi.fn(),
}))

vi.mock('./transactions.js', () => ({
  fetchVaultBox: (...args: unknown[]) => fetchVaultBoxMock(...args),
}))

const { fetchVaultBoxMock } = vi.hoisted(() => ({
  fetchVaultBoxMock: vi.fn(),
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

describe('getCampaignStatus', () => {
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
    lookupApplicationsMock.mockImplementation(() => lookupApplicationChain)
    lookupBlockMock.mockImplementation(() => lookupBlockChain)
    fetchVaultBoxMock.mockResolvedValue(undefined)
    const lookupApplicationsDoMock = vi.fn(() => Promise.resolve({ application: undefined }))
    const lookupBlockDoMock = vi.fn(() => Promise.resolve({ transactions: [] }))
    const lookupApplicationChain = { includeAll: () => lookupApplicationChain, do: lookupApplicationsDoMock }
    const lookupBlockChain = { do: lookupBlockDoMock }
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

describe('fetchCampaignHeader', () => {
  let lookupApplicationsDoMock: ReturnType<typeof vi.fn>
  let lookupBlockDoMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    lookupApplicationsDoMock = vi.fn()
    lookupApplicationsDoMock.mockResolvedValue({
      application: {
        id: 42n,
        deleted: false,
        params: {
          creator: 'SENDER',
          approvalProgram: new Uint8Array(),
          clearStateProgram: new Uint8Array(),
          globalState: [
            kv('title', tealBytes(new TextEncoder().encode('My first novel'))),
            kv('metadataUri', tealBytes(new TextEncoder().encode('ipfs://QmExample'))),
            kv('goal', tealUint(10_000_000n)),
            kv('deadline', tealUint(2_000n)),
            kv('raised', tealUint(5_000_000n)),
            kv('status', tealUint(0n)),
          ],
        },
      },
    })
    lookupBlockDoMock = vi.fn()
    lookupBlockDoMock.mockResolvedValue({ transactions: [] })
    fetchVaultBoxMock.mockResolvedValue(undefined)
    const lookupApplicationChain = { includeAll: () => lookupApplicationChain, do: lookupApplicationsDoMock }
    const lookupBlockChain = { do: lookupBlockDoMock }
    lookupApplicationsMock.mockImplementation(() => lookupApplicationChain)
    lookupBlockMock.mockImplementation(() => lookupBlockChain)
  })

  it('reads a live campaign from global state', async () => {
    const header = await fetchCampaignHeader(42n)
    expect(header).toEqual({
      id: 42n,
      creator: 'SENDER',
      title: 'My first novel',
      metadataUri: 'ipfs://QmExample',
      goalMicroAlgos: 10_000_000n,
      deadlineSeconds: 2_000n,
      raisedMicroAlgos: 5_000_000n,
      status: 'open',
      deleted: false,
    })
    expect(lookupApplicationsMock).toHaveBeenCalledWith(42n)
  })

  it('live campaign with missing global-state keys falls back to zero/empty', async () => {
    lookupApplicationsDoMock.mockResolvedValue({
      application: {
        id: 42n,
        deleted: false,
        params: { creator: 'SENDER', approvalProgram: new Uint8Array(), clearStateProgram: new Uint8Array() },
      },
    })
    const header = await fetchCampaignHeader(42n)
    expect(header).toEqual({
      id: 42n,
      creator: 'SENDER',
      title: '',
      metadataUri: '',
      goalMicroAlgos: 0n,
      deadlineSeconds: 0n,
      raisedMicroAlgos: 0n,
      status: 'open',
      deleted: false,
    })
  })

  it('live campaign with failed status maps to failed', async () => {
    lookupApplicationsDoMock.mockResolvedValue({
      application: {
        id: 42n,
        deleted: false,
        params: {
          creator: 'SENDER',
          approvalProgram: new Uint8Array(),
          clearStateProgram: new Uint8Array(),
          globalState: [kv('status', tealUint(1n))],
        },
      },
    })
    const header = await fetchCampaignHeader(42n)
    expect(header).toEqual(expect.objectContaining({ status: 'failed' }))
  })

  it('live campaign with claimed status maps to claimed', async () => {
    lookupApplicationsDoMock.mockResolvedValue({
      application: {
        id: 42n,
        deleted: false,
        params: {
          creator: 'SENDER',
          approvalProgram: new Uint8Array(),
          clearStateProgram: new Uint8Array(),
          globalState: [kv('status', tealUint(2n))],
        },
      },
    })
    const header = await fetchCampaignHeader(42n)
    expect(header).toEqual(expect.objectContaining({ status: 'claimed' }))
  })

  it('decodes a deleted campaign from its creation transaction and vault box', async () => {
    const vaultBox = { paidIn: 7_000_000n, paidOut: 1_000_000n, status: 3, settledAt: 1_500n }
    lookupApplicationsDoMock.mockResolvedValue({
      application: {
        id: 42n,
        deleted: true,
        createdAtRound: 100n,
        params: {
          creator: 'SENDER',
          approvalProgram: new Uint8Array(),
          clearStateProgram: new Uint8Array(),
          globalState: [],
        },
      },
    })
    lookupBlockDoMock.mockResolvedValue({
      transactions: [
        {
          id: 'tx-create',
          sender: 'SENDER',
          createdApplicationIndex: 42n,
          applicationTransaction: {
            applicationId: 0n,
            applicationArgs: [
              new Uint8Array([0, 32, ...new Uint8Array(32).fill(1)]),
              new Uint8Array([0, 16, ...new TextEncoder().encode('Deleted campaign')]),
              new Uint8Array([0, 8, ...new TextEncoder().encode('ipfs://x')]),
              new Uint8Array([0, 0, 0, 0, 0, 0x98, 0x96, 0x80]),
              new Uint8Array([0, 0, 0, 0, 0, 0, 0x07, 0xd0]),
            ],
          },
        },
      ],
    })
    fetchVaultBoxMock.mockResolvedValue(vaultBox)

    const header = await fetchCampaignHeader(42n)
    expect(header).toEqual({
      id: 42n,
      creator: 'SENDER',
      title: 'Deleted campaign',
      metadataUri: 'ipfs://x',
      goalMicroAlgos: 10_000_000n,
      deadlineSeconds: 2_000n,
      raisedMicroAlgos: 6_000_000n,
      status: 'claimed',
      deleted: true,
    })
    expect(lookupBlockMock).toHaveBeenCalledWith(100n)
    expect(fetchVaultBoxMock).toHaveBeenCalledWith(42n)
  })

  it('returns a deleted campaign with no vault box as open with zero raised', async () => {
    lookupApplicationsDoMock.mockResolvedValue({
      application: {
        id: 42n,
        deleted: true,
        createdAtRound: 100n,
        params: {
          creator: 'SENDER',
          approvalProgram: new Uint8Array(),
          clearStateProgram: new Uint8Array(),
          globalState: [],
        },
      },
    })
    lookupBlockDoMock.mockResolvedValue({
      transactions: [
        {
          id: 'tx-create',
          sender: 'SENDER',
          createdApplicationIndex: 42n,
          applicationTransaction: {
            applicationId: 0n,
            applicationArgs: [
              new Uint8Array([0, 32, ...new Uint8Array(32)]),
              new Uint8Array([0, 16, ...new TextEncoder().encode('Deleted campaign')]),
              new Uint8Array([0, 8, ...new TextEncoder().encode('ipfs://x')]),
              new Uint8Array([0, 0, 0, 0, 0, 0x98, 0x96, 0x80]),
              new Uint8Array([0, 0, 0, 0, 0, 0, 0x07, 0xd0]),
            ],
          },
        },
      ],
    })
    fetchVaultBoxMock.mockResolvedValue(undefined)

    const header = await fetchCampaignHeader(42n)
    expect(header).toEqual({
      id: 42n,
      creator: 'SENDER',
      title: 'Deleted campaign',
      metadataUri: 'ipfs://x',
      goalMicroAlgos: 10_000_000n,
      deadlineSeconds: 2_000n,
      raisedMicroAlgos: 0n,
      status: 'open',
      deleted: true,
    })
  })

  it('returns undefined for an unknown app id', async () => {
    lookupApplicationsDoMock.mockResolvedValue({ application: undefined })
    const header = await fetchCampaignHeader(999n)
    expect(header).toBeUndefined()
  })

  it('deleted campaign without a creation round falls back to indexer creator and open status', async () => {
    lookupApplicationsDoMock.mockResolvedValue({
      application: {
        id: 42n,
        deleted: true,
        params: { approvalProgram: new Uint8Array(), clearStateProgram: new Uint8Array() },
      },
    })
    lookupBlockDoMock.mockResolvedValue({ transactions: [] })
    fetchVaultBoxMock.mockResolvedValue({ paidIn: 3_000_000n, paidOut: 0n, status: 1, settledAt: 0n })

    const header = await fetchCampaignHeader(42n)
    expect(header).toEqual({
      id: 42n,
      creator: '',
      title: '',
      metadataUri: '',
      goalMicroAlgos: 0n,
      deadlineSeconds: 0n,
      raisedMicroAlgos: 3_000_000n,
      status: 'open',
      deleted: true,
    })
    expect(lookupBlockMock).not.toHaveBeenCalled()
    expect(fetchVaultBoxMock).toHaveBeenCalledWith(42n)
  })

  it('deleted campaign whose creation tx is missing from the block stays open with zero raised', async () => {
    lookupApplicationsDoMock.mockResolvedValue({
      application: {
        id: 42n,
        deleted: true,
        createdAtRound: 100n,
        params: { creator: 'SENDER', approvalProgram: new Uint8Array(), clearStateProgram: new Uint8Array() },
      },
    })
    lookupBlockDoMock.mockResolvedValue({})
    fetchVaultBoxMock.mockResolvedValue({ paidIn: 5_000_000n, paidOut: 1_000_000n, status: 2, settledAt: 0n })

    const header = await fetchCampaignHeader(42n)
    expect(header).toEqual({
      id: 42n,
      creator: 'SENDER',
      title: '',
      metadataUri: '',
      goalMicroAlgos: 0n,
      deadlineSeconds: 0n,
      raisedMicroAlgos: 4_000_000n,
      status: 'failed',
      deleted: true,
    })
    expect(lookupBlockMock).toHaveBeenCalledWith(100n)
  })

  it('deleted campaign whose creation tx has no args stays open with zero raised', async () => {
    lookupApplicationsDoMock.mockResolvedValue({
      application: {
        id: 42n,
        deleted: true,
        createdAtRound: 100n,
        params: { creator: 'SENDER', approvalProgram: new Uint8Array(), clearStateProgram: new Uint8Array() },
      },
    })
    lookupBlockDoMock.mockResolvedValue({
      transactions: [
        {
          id: 'tx-create',
          sender: 'SENDER',
          createdApplicationIndex: 42n,
          applicationTransaction: { applicationId: 0n, applicationArgs: [] },
        },
      ],
    })
    fetchVaultBoxMock.mockResolvedValue(undefined)

    const header = await fetchCampaignHeader(42n)
    expect(header).toEqual({
      id: 42n,
      creator: 'SENDER',
      title: '',
      metadataUri: '',
      goalMicroAlgos: 0n,
      deadlineSeconds: 0n,
      raisedMicroAlgos: 0n,
      status: 'open',
      deleted: true,
    })
    expect(lookupBlockMock).toHaveBeenCalledWith(100n)
    expect(fetchVaultBoxMock).toHaveBeenCalledWith(42n)
  })
})
