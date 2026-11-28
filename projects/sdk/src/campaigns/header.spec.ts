import { VAULT_BOX_STATUS_CLAIMED_HEX, VAULT_BOX_STATUS_FAILED_HEX, VAULT_BOX_STATUS_OPEN_HEX } from '@kasakame/constants'
import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchCampaignHeader } from './index.js'

const VAULT_BOX_STATUS_OPEN = Number.parseInt(VAULT_BOX_STATUS_OPEN_HEX, 16)
const VAULT_BOX_STATUS_FAILED = Number.parseInt(VAULT_BOX_STATUS_FAILED_HEX, 16)
const VAULT_BOX_STATUS_CLAIMED = Number.parseInt(VAULT_BOX_STATUS_CLAIMED_HEX, 16)

vi.mock('../runtime/config.js', () => ({
  getSdkConfig: () => ({
    algorand: {
      client: {
        indexer: {
          lookupApplications: (...args: unknown[]) => lookupApplicationsMock(...args),
          lookupBlock: (...args: unknown[]) => lookupBlockMock(...args),
        },
      },
    },
    registryAppId: 1001n,
    vaultAppId: 2002n,
  }),
}))

const { lookupApplicationsMock, lookupBlockMock } = vi.hoisted(() => ({
  lookupApplicationsMock: vi.fn(),
  lookupBlockMock: vi.fn(),
}))

vi.mock('../transactions/vault.js', () => ({
  fetchVaultBox: (...args: unknown[]) => fetchVaultBoxMock(...args),
}))

const { fetchVaultBoxMock } = vi.hoisted(() => ({
  fetchVaultBoxMock: vi.fn(),
}))

function tealUint(value: bigint): algosdk.indexerModels.TealValue {
  return new algosdk.indexerModels.TealValue({ bytes: new Uint8Array(), type: 2, uint: value })
}

function tealBytes(value: Uint8Array): algosdk.indexerModels.TealValue {
  return new algosdk.indexerModels.TealValue({ bytes: value, type: 1, uint: 0n })
}

function kv(key: string, value: algosdk.indexerModels.TealValue): algosdk.indexerModels.TealKeyValue {
  return new algosdk.indexerModels.TealKeyValue({ key: new TextEncoder().encode(key), value })
}

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
    const vaultBox = { paidIn: 7_000_000n, paidOut: 1_000_000n, status: VAULT_BOX_STATUS_CLAIMED, settledAt: 1_500n }
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
    fetchVaultBoxMock.mockResolvedValue({ paidIn: 3_000_000n, paidOut: 0n, status: VAULT_BOX_STATUS_OPEN, settledAt: 0n })

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
    fetchVaultBoxMock.mockResolvedValue({ paidIn: 5_000_000n, paidOut: 1_000_000n, status: VAULT_BOX_STATUS_FAILED, settledAt: 0n })

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
