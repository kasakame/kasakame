import { REGISTRY_BOX_PREFIX, VAULT_BOX_PREFIX } from '@kasakame/constants'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enumerateCampaigns, fetchRegisteredCampaignIds, isRegistered } from './index.js'

vi.mock('../runtime/config.js', () => ({
  getSdkConfig: () => ({
    algorand: {
      client: {
        indexer: {
          searchForApplicationBoxes: (...args: unknown[]) => searchForApplicationBoxesMock(...args),
        },
      },
    },
    registryAppId: registryAppIdMock(),
    vaultAppId: 2002n,
  }),
}))

vi.mock('../generated/RegistryClient.js', () => ({
  RegistryClient: class {
    state = { box: { registered: { value: (...args: unknown[]) => registeredValueMock(...args) } } }
  },
}))

const { registryAppIdMock, searchForApplicationBoxesMock, registeredValueMock } = vi.hoisted(() => ({
  registryAppIdMock: vi.fn(() => 1001n),
  searchForApplicationBoxesMock: vi.fn(),
  registeredValueMock: vi.fn(),
}))

// Indexer `searchForApplicationBoxes` returns a limit/nextToken/do chain, mocked per app id: 1001n => registry boxes, 2002n => vault boxes.
let registryBoxesValue: { boxes: { name: Uint8Array }[]; nextToken: string | undefined }
let vaultBoxesValue: { boxes: { name: Uint8Array }[]; nextToken: string | undefined }
const registryLimitMock = vi.fn(() => registryChain)
const registryNextTokenMock = vi.fn(() => registryChain)
const registryDoMock = vi.fn(() => Promise.resolve(registryBoxesValue))
const registryChain = { limit: registryLimitMock, nextToken: registryNextTokenMock, do: registryDoMock }
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
  if (appId === 1001n) return registryChain
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

const REGISTRATION_BOX_PREFIX_BYTE = REGISTRY_BOX_PREFIX.charCodeAt(0)
const VAULT_BOX_PREFIX_BYTE = VAULT_BOX_PREFIX.charCodeAt(0)

/**
 * A Registry registration box name: 'r' + the 8-byte big-endian app id.
 *
 * @param appId The campaign app id to encode.
 * @returns The 9-byte box name.
 */
function registrationBoxName(appId: bigint): Uint8Array {
  return boxName(appId, REGISTRATION_BOX_PREFIX_BYTE)
}

function boxSearchBuilder(getBoxes: () => { name: Uint8Array }[]): unknown {
  return {
    limit: () => boxSearchBuilder(getBoxes),
    nextToken: () => boxSearchBuilder(getBoxes),
    do: () => ({ boxes: getBoxes(), nextToken: undefined }),
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  registryAppIdMock.mockReturnValue(1001n)
  registryBoxesValue = { boxes: [], nextToken: undefined }
  vaultBoxesValue = { boxes: [], nextToken: undefined }
  searchForApplicationBoxesMock.mockImplementation((appId: bigint) => {
    if (appId === 1001n) return registryChain
    if (appId === 2002n) return vaultChain
    return emptyChain
  })
  registryLimitMock.mockImplementation(() => registryChain)
  registryNextTokenMock.mockImplementation(() => registryChain)
  registryDoMock.mockImplementation(() => Promise.resolve(registryBoxesValue))
  vaultLimitMock.mockImplementation(() => vaultChain)
  vaultNextTokenMock.mockImplementation(() => vaultChain)
  vaultDoMock.mockImplementation(() => Promise.resolve(vaultBoxesValue))
})

describe('enumerateCampaigns', () => {
  it('lists registry-registered campaign ids', async () => {
    registryBoxesValue = {
      boxes: [{ name: boxName(7n, REGISTRATION_BOX_PREFIX_BYTE) }, { name: boxName(42n, REGISTRATION_BOX_PREFIX_BYTE) }],
      nextToken: undefined,
    }
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set([7n, 42n]))
    expect(searchForApplicationBoxesMock).toHaveBeenCalledWith(1001n)
    expect(searchForApplicationBoxesMock).toHaveBeenCalledWith(2002n)
    expect(registryLimitMock).toHaveBeenCalledWith(1000)
  })

  it('includes vault-boxed campaigns not registered with the registry', async () => {
    registryBoxesValue = { boxes: [{ name: boxName(7n, REGISTRATION_BOX_PREFIX_BYTE) }], nextToken: undefined }
    vaultBoxesValue = { boxes: [{ name: boxName(9n, VAULT_BOX_PREFIX_BYTE) }], nextToken: undefined }
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set([7n, 9n]))
  })

  it('dedupes campaigns present in both the registry and the vault', async () => {
    registryBoxesValue = { boxes: [{ name: boxName(7n, REGISTRATION_BOX_PREFIX_BYTE) }], nextToken: undefined }
    vaultBoxesValue = { boxes: [{ name: boxName(7n, VAULT_BOX_PREFIX_BYTE) }], nextToken: undefined }
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set([7n]))
  })

  it('returns an empty set when neither source lists campaigns', async () => {
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set())
  })

  it('skips malformed box names from either source', async () => {
    registryBoxesValue = {
      boxes: [
        { name: boxName(7n, REGISTRATION_BOX_PREFIX_BYTE) },
        { name: new Uint8Array([REGISTRATION_BOX_PREFIX_BYTE, 0, 0, 0, 0, 0, 0, 0]) }, // 8 bytes: wrong length
        { name: new Uint8Array([0x00, 0, 0, 0, 0, 0, 0, 0, 7]) }, // 9 bytes: wrong prefix
      ],
      nextToken: undefined,
    }
    vaultBoxesValue = {
      boxes: [
        { name: boxName(9n, VAULT_BOX_PREFIX_BYTE) },
        { name: new Uint8Array([VAULT_BOX_PREFIX_BYTE, 0, 0, 0, 0, 0, 0, 0]) }, // 8 bytes: wrong length
      ],
      nextToken: undefined,
    }
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set([7n, 9n]))
  })

  it('skips the registry when no registry is configured', async () => {
    registryAppIdMock.mockReturnValue(0n)
    vaultBoxesValue = { boxes: [{ name: boxName(9n, VAULT_BOX_PREFIX_BYTE) }], nextToken: undefined }
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set([9n]))
    expect(searchForApplicationBoxesMock).not.toHaveBeenCalledWith(1001n)
    expect(searchForApplicationBoxesMock).toHaveBeenCalledWith(2002n)
  })

  it('paginates both box searches across multiple pages', async () => {
    registryDoMock
      .mockResolvedValueOnce({ boxes: [{ name: boxName(7n, REGISTRATION_BOX_PREFIX_BYTE) }], nextToken: 't' })
      .mockResolvedValueOnce({ boxes: [{ name: boxName(42n, REGISTRATION_BOX_PREFIX_BYTE) }], nextToken: undefined })
    vaultDoMock
      .mockResolvedValueOnce({ boxes: [], nextToken: 'vt' })
      .mockResolvedValueOnce({ boxes: [{ name: boxName(9n, VAULT_BOX_PREFIX_BYTE) }], nextToken: undefined })
    const ids = await enumerateCampaigns()
    expect(ids).toEqual(new Set([7n, 42n, 9n]))
    expect(registryNextTokenMock).toHaveBeenCalledWith('t')
    expect(vaultNextTokenMock).toHaveBeenCalledWith('vt')
  })
})

describe('fetchRegisteredCampaignIds', () => {
  it('decodes registration box names into app ids', async () => {
    searchForApplicationBoxesMock.mockImplementation(() =>
      boxSearchBuilder(() => [
        { name: registrationBoxName(7n) },
        { name: registrationBoxName(1_234_567_890n) },
        { name: new Uint8Array([REGISTRATION_BOX_PREFIX_BYTE, 1, 2, 3]) }, // malformed: too short
        { name: new Uint8Array([0x71, 1, 2, 3, 4, 5, 6, 7, 8]) }, // wrong prefix
      ]),
    )
    const ids = await fetchRegisteredCampaignIds(1001n)
    expect([...ids]).toEqual([7n, 1_234_567_890n])
  })

  it('follows box search pages', async () => {
    const pages = [{ boxes: [{ name: registrationBoxName(7n) }], nextToken: 't' }, { boxes: [{ name: registrationBoxName(8n) }] }]
    searchForApplicationBoxesMock.mockImplementation(() => ({
      limit: () => ({
        nextToken: () => ({
          do: () => Promise.resolve(pages.shift() ?? { boxes: [] }),
        }),
        do: () => Promise.resolve(pages.shift() ?? { boxes: [] }),
      }),
    }))
    expect([...(await fetchRegisteredCampaignIds(1001n))]).toEqual([7n, 8n])
  })
})

describe('isRegistered', () => {
  it('reads the Registry registration box', async () => {
    registeredValueMock.mockResolvedValue('ADDRESS')
    await expect(isRegistered(42n)).resolves.toBe(true)
    expect(registeredValueMock).toHaveBeenCalledWith(42n)
  })

  it('returns false when the registration box is missing', async () => {
    await expect(isRegistered(42n)).resolves.toBe(false)
  })

  it('returns false when algod reports the registration box missing', async () => {
    registeredValueMock.mockRejectedValue(new Error('Network request error. Received status 404 (Not Found): box not found'))
    await expect(isRegistered(42n)).resolves.toBe(false)
  })

  it('rethrows other registration read errors', async () => {
    registeredValueMock.mockRejectedValue(new Error('algod unavailable'))
    await expect(isRegistered(42n)).rejects.toThrow('algod unavailable')
  })

  it('returns false without a configured Registry', async () => {
    registryAppIdMock.mockReturnValue(0n)
    await expect(isRegistered(42n)).resolves.toBe(false)
    expect(registeredValueMock).not.toHaveBeenCalled()
  })
})
