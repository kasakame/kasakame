import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { REGISTRY_BOX_PREFIX, VAULT_BOX_STATUS_CLAIMED_HEX } from '@kasakame/constants'
import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureSdk } from '../runtime/config.js'
import { setSdkLogger } from '../runtime/log.js'
import { clearCachedCampaigns, fetchMyPledge, getCachedCampaigns, getCampaign, listCampaigns } from './index.js'

const indexerMock = vi.hoisted(() => ({
  lookupApplications: vi.fn(),
  lookupBlock: vi.fn(),
  searchForApplications: vi.fn(),
  searchForApplicationBoxes: vi.fn(),
}))

const fetchMyLeavesMock = vi.hoisted(() => vi.fn())
const fetchVaultBoxMock = vi.hoisted(() => vi.fn())

vi.mock('../claim-tree/index.js', async () => {
  const actual = await vi.importActual('../claim-tree/index.js')
  return { ...actual, fetchMyLeaves: (...args: unknown[]) => fetchMyLeavesMock(...args) }
})

vi.mock('../transactions/vault.js', () => ({
  fetchVaultBox: (...args: unknown[]) => fetchVaultBoxMock(...args),
}))

const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'

function fakeAlgorand(): AlgorandClient {
  return {
    client: {
      indexer: indexerMock,
      algod: {
        status: () => ({ do: () => Promise.resolve({ lastRound: 5n }) }),
        block: () => ({ headerOnly: () => ({ do: () => Promise.resolve({ block: { header: { timestamp: 1_000n } } }) }) }),
      },
    },
  } as unknown as AlgorandClient
}

function tealUint(value: bigint): algosdk.indexerModels.TealValue {
  return new algosdk.indexerModels.TealValue({ bytes: new Uint8Array(), type: 2, uint: value })
}

function tealBytes(value: Uint8Array): algosdk.indexerModels.TealValue {
  return new algosdk.indexerModels.TealValue({ bytes: value, type: 1, uint: 0n })
}

function kv(key: string, value: algosdk.indexerModels.TealValue): algosdk.indexerModels.TealKeyValue {
  return new algosdk.indexerModels.TealKeyValue({ key: new TextEncoder().encode(key), value })
}

function campaignApp(overrides: { id?: bigint } = {}): algosdk.indexerModels.Application {
  const globalState = [
    kv('creator', tealBytes(algosdk.decodeAddress(ZERO_ADDRESS).publicKey)),
    kv('title', tealBytes(new TextEncoder().encode('My first novel'))),
    kv('metadataUri', tealBytes(new TextEncoder().encode('ipfs://QmExample'))),
    kv('goal', tealUint(10_000_000n)),
    kv('deadline', tealUint(2_000n)),
    kv('raised', tealUint(5_000_000n)),
    kv('status', tealUint(0n)),
    kv('root', tealBytes(new Uint8Array(32))),
    kv('n', tealUint(0n)),
  ]
  return new algosdk.indexerModels.Application({
    id: overrides.id ?? 42n,
    params: new algosdk.indexerModels.ApplicationParams({
      approvalProgram: new Uint8Array(),
      clearStateProgram: new Uint8Array(),
      globalState,
    }),
  })
}

// A chainable indexer builder for lookup endpoints.
function lookupBuilder(response: unknown, throws = false): unknown {
  const builder = {
    assetId: () => builder,
    includeAll: () => builder,
    do: () => (throws ? Promise.reject(new Error('not found')) : Promise.resolve(response)),
  }
  return builder
}

function rejectingBuilder(reason: unknown): unknown {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection exercises the stringified log path
  const builder = { includeAll: () => builder, do: () => Promise.reject(reason) }
  return builder
}

function searchBuilder(getApplications: () => algosdk.indexerModels.Application[]): unknown {
  return {
    limit: () => searchBuilder(getApplications),
    do: () => ({ applications: getApplications() }),
  }
}

function boxSearchBuilder(getBoxes: () => { name: Uint8Array }[]): unknown {
  return {
    limit: () => boxSearchBuilder(getBoxes),
    nextToken: () => boxSearchBuilder(getBoxes),
    do: () => ({ boxes: getBoxes(), nextToken: undefined }),
  }
}

/**
 * A Registry registration box name: 'r' + the 8-byte big-endian app id.
 *
 * @param appId The campaign app id to encode.
 * @returns The 9-byte box name.
 */
function registrationBoxName(appId: bigint): Uint8Array {
  const name = new Uint8Array(9)
  name[0] = REGISTRY_BOX_PREFIX.charCodeAt(0)
  for (let i = 8; i >= 1; i--) {
    name[i] = Number(appId & 0xffn)
    appId >>= 8n
  }
  return name
}

beforeEach(() => {
  vi.clearAllMocks()
  clearCachedCampaigns()
  fetchVaultBoxMock.mockResolvedValue(undefined)
  configureSdk({ algorand: fakeAlgorand(), registryAppId: 1001n, vaultAppId: 2002n })
})

describe('cached base list', () => {
  it('stores the listed campaigns for instant paint', async () => {
    indexerMock.searchForApplicationBoxes.mockImplementation(() => boxSearchBuilder(() => [{ name: registrationBoxName(42n) }]))
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: campaignApp({ id: 42n }) }))

    await listCampaigns()
    expect(getCachedCampaigns()?.campaigns.map((c) => c.id)).toEqual([42n])
  })

  it('clears the cached list', async () => {
    indexerMock.searchForApplicationBoxes.mockImplementation(() => boxSearchBuilder(() => [{ name: registrationBoxName(42n) }]))
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: campaignApp({ id: 42n }) }))

    await listCampaigns()
    clearCachedCampaigns()
    expect(getCachedCampaigns()).toBeUndefined()
  })
})

describe('fetchMyPledge', () => {
  it('sums the viewer’s live leaves', async () => {
    fetchMyLeavesMock.mockResolvedValue([
      { position: 0, amount: 600_000n, txidHex: 'aa' },
      { position: 2, amount: 400_000n, txidHex: 'bb' },
    ])
    expect(await fetchMyPledge(42n, 'ADDRESS')).toBe(1_000_000n)
  })

  it('returns undefined when the viewer has no live leaves', async () => {
    fetchMyLeavesMock.mockResolvedValue([])
    expect(await fetchMyPledge(42n, 'ADDRESS')).toBeUndefined()
  })
})

describe('listCampaigns', () => {
  it('lists registered campaigns by direct lookup without scanning', async () => {
    indexerMock.searchForApplicationBoxes.mockImplementation(() => boxSearchBuilder(() => [{ name: registrationBoxName(42n) }]))
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: campaignApp({ id: 42n }) }))

    const { campaigns } = await listCampaigns()
    expect(campaigns.map((c) => c.id)).toEqual([42n])
    expect(indexerMock.searchForApplications).not.toHaveBeenCalled()
  })

  it('skips deleted campaigns', async () => {
    const deleted = new algosdk.indexerModels.Application({
      id: 44n,
      deleted: true,
      params: new algosdk.indexerModels.ApplicationParams({
        approvalProgram: new Uint8Array(),
        clearStateProgram: new Uint8Array(),
      }),
    })
    indexerMock.searchForApplicationBoxes.mockImplementation(() => boxSearchBuilder(() => [{ name: registrationBoxName(44n) }]))
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: deleted }))

    expect((await listCampaigns()).campaigns).toEqual([])
  })

  it('keeps readable campaigns when one registered lookup fails', async () => {
    const warn = vi.fn()
    setSdkLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() })
    indexerMock.searchForApplicationBoxes.mockImplementation(() =>
      boxSearchBuilder(() => [{ name: registrationBoxName(42n) }, { name: registrationBoxName(43n) }]),
    )
    indexerMock.lookupApplications.mockImplementation((id: bigint) =>
      id === 43n ? lookupBuilder({}, true) : lookupBuilder({ application: campaignApp({ id }) }),
    )

    const { campaigns } = await listCampaigns()
    expect(campaigns.map((campaign) => campaign.id)).toEqual([42n])
    expect(warn).toHaveBeenCalledWith('campaigns.list.lookup-failed', { appId: '43', message: 'not found' })
  })

  it('logs a non-Error lookup failure and skips a missing application', async () => {
    const warn = vi.fn()
    setSdkLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() })
    indexerMock.searchForApplicationBoxes.mockImplementation(() =>
      boxSearchBuilder(() => [{ name: registrationBoxName(44n) }, { name: registrationBoxName(45n) }]),
    )
    indexerMock.lookupApplications.mockImplementation((id: bigint) => (id === 45n ? rejectingBuilder('offline') : lookupBuilder({})))

    const { campaigns } = await listCampaigns()
    expect(campaigns).toEqual([])
    expect(warn).toHaveBeenCalledWith('campaigns.list.lookup-failed', { appId: '45', message: 'offline' })
  })

  it('falls back to the full scan without a registry', async () => {
    configureSdk({ algorand: fakeAlgorand(), registryAppId: 0n, vaultAppId: 2002n })
    const official = campaignApp({ id: 42n })
    const unrelated = new algosdk.indexerModels.Application({
      id: 44n,
      params: new algosdk.indexerModels.ApplicationParams({
        approvalProgram: new Uint8Array(),
        clearStateProgram: new Uint8Array(),
        globalState: [kv('nope', tealUint(1n))],
      }),
    })
    indexerMock.searchForApplications.mockImplementation(() => searchBuilder(() => [official, unrelated]))

    const { campaigns } = await listCampaigns()
    expect(campaigns.map((c) => c.id)).toEqual([42n])
    expect(indexerMock.searchForApplicationBoxes).not.toHaveBeenCalled()
  })

  it('follows application scan pages without a registry', async () => {
    configureSdk({ algorand: fakeAlgorand(), registryAppId: 0n, vaultAppId: 2002n })
    const pages = [{ applications: [campaignApp({ id: 42n })], nextToken: 't' }, { applications: [campaignApp({ id: 43n })] }]
    indexerMock.searchForApplications.mockImplementation(() => ({
      limit: () => ({
        nextToken: () => ({
          do: () => Promise.resolve(pages.shift() ?? { applications: [] }),
        }),
        do: () => Promise.resolve(pages.shift() ?? { applications: [] }),
      }),
    }))

    const { campaigns } = await listCampaigns()
    expect(campaigns.map((c) => c.id)).toEqual([42n, 43n])
  })

  it('returns undefined for a missing application', async () => {
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({}))
    expect(await getCampaign(44n, 3_000n)).toBeUndefined()
  })

  it('includes viewer pledges in the full scan without a registry', async () => {
    configureSdk({ algorand: fakeAlgorand(), registryAppId: 0n, vaultAppId: 2002n })
    indexerMock.searchForApplications.mockImplementation(() => searchBuilder(() => [campaignApp({ id: 42n })]))
    fetchMyLeavesMock.mockResolvedValue([{ position: 0, amount: 250_000n, txidHex: 'aa' }])

    const { campaigns } = await listCampaigns('ADDRESS')
    expect(campaigns[0]?.myPledgeMicroAlgos).toBe(250_000n)
  })
})

describe('getCampaign', () => {
  it('returns the campaign with the viewer pledge', async () => {
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: campaignApp() }))
    fetchMyLeavesMock.mockResolvedValue([{ position: 0, amount: 250_000n, txidHex: 'aa' }])
    const vm = await getCampaign(42n, 3_000n, 'ADDRESS')
    expect(vm?.id).toBe(42n)
    expect(vm?.myPledgeMicroAlgos).toBe(250_000n)
  })

  it('recovers a deleted campaign from its creation transaction and vault box', async () => {
    const deleted = new algosdk.indexerModels.Application({
      id: 44n,
      deleted: true,
      createdAtRound: 100n,
      params: new algosdk.indexerModels.ApplicationParams({
        creator: ZERO_ADDRESS,
        approvalProgram: new Uint8Array(),
        clearStateProgram: new Uint8Array(),
      }),
    })
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: deleted }))
    indexerMock.lookupBlock.mockImplementation(() =>
      lookupBuilder({
        transactions: [
          {
            id: 'tx-create',
            sender: 'SENDER',
            createdApplicationIndex: 44n,
            applicationTransaction: {
              applicationId: 0n,
              // Selector, then the ARC-56 tuple: vault uint64, title, metadataUri, goal, deadline.
              applicationArgs: [
                new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]),
                new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]),
                new Uint8Array([0, 16, ...new TextEncoder().encode('Deleted campaign')]),
                new Uint8Array([0, 8, ...new TextEncoder().encode('ipfs://x')]),
                new Uint8Array([0, 0, 0, 0, 0, 0x98, 0x96, 0x80]),
                new Uint8Array([0, 0, 0, 0, 0, 0, 0x07, 0xd0]),
              ],
            },
          },
        ],
      }),
    )
    fetchVaultBoxMock.mockResolvedValue({
      paidIn: 7_000_000n,
      paidOut: 1_000_000n,
      status: Number.parseInt(VAULT_BOX_STATUS_CLAIMED_HEX, 16),
      settledAt: 1_500n,
    })

    expect(await getCampaign(44n, 3_000n)).toEqual({
      id: 44n,
      creator: ZERO_ADDRESS,
      title: 'Deleted campaign',
      metadataUri: 'ipfs://x',
      goalMicroAlgos: 10_000_000n,
      raisedMicroAlgos: 6_000_000n,
      deadlineSeconds: 2_000n,
      status: 'successful',
      claimed: true,
      deleted: true,
    })
    expect(indexerMock.lookupBlock).toHaveBeenCalledWith(100n)
    expect(fetchVaultBoxMock).toHaveBeenCalledWith(44n)
  })

  it('returns undefined for a non-campaign app', async () => {
    const unrelated = new algosdk.indexerModels.Application({
      id: 44n,
      params: new algosdk.indexerModels.ApplicationParams({
        approvalProgram: new Uint8Array(),
        clearStateProgram: new Uint8Array(),
        globalState: [kv('nope', tealUint(1n))],
      }),
    })
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: unrelated }))
    expect(await getCampaign(44n, 3_000n)).toBeUndefined()
  })
})
