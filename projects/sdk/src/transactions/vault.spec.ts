import { VAULT_BOX_STATUS_FAILED_HEX } from '@kasakame/constants'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VAULT_APP_ADDRESS,
  campaignBoxValueMock,
  refundWindowMock,
  resetMocks,
  sweepTargetMock,
  vaultRegistryMock,
} from './test-fixtures.js'
import { fetchVaultBox, fetchVaultConfig, refundWindowEndsAt, vaultAddress } from './vault.js'

vi.mock('../generated/ClaimsVaultClient.js', async () => (await import('./test-fixtures.js')).vaultClientModule)
vi.mock('../runtime/config.js', async () => (await import('./test-fixtures.js')).runtimeConfigModule)

beforeEach(resetMocks)

describe('vault helpers', () => {
  it('vaultAddress derives from the configured vault app id', () => {
    expect(vaultAddress()).toBe(VAULT_APP_ADDRESS)
  })

  it('fetchVaultBox unpacks the 65-byte box, or undefined when missing', async () => {
    const box = new Uint8Array(65)
    box[56] = 2
    campaignBoxValueMock.mockResolvedValue(box)
    await expect(fetchVaultBox(9n)).resolves.toMatchObject({ status: Number.parseInt(VAULT_BOX_STATUS_FAILED_HEX, 16) })

    campaignBoxValueMock.mockRejectedValue(new Error('box not found'))
    await expect(fetchVaultBox(9n)).resolves.toBeUndefined()

    campaignBoxValueMock.mockRejectedValue(new Error('socket hang up'))
    await expect(fetchVaultBox(9n)).rejects.toThrow('socket hang up')

    campaignBoxValueMock.mockResolvedValue(new Uint8Array(3))
    await expect(fetchVaultBox(9n)).resolves.toBeUndefined()
  })

  it('fetchVaultConfig reads the Registry, window, and sweep target', async () => {
    refundWindowMock.mockResolvedValue(63_072_000n)
    sweepTargetMock.mockResolvedValue('SWEEP')
    vaultRegistryMock.mockResolvedValue(1_001n)
    await expect(fetchVaultConfig()).resolves.toEqual({ registryAppId: 1_001n, window: 63_072_000n, sweepTarget: 'SWEEP' })
  })

  it('fetchVaultConfig defaults a missing Registry to zero', async () => {
    vaultRegistryMock.mockResolvedValue(undefined)
    await expect(fetchVaultConfig()).resolves.toMatchObject({ registryAppId: 0n })
  })

  it('refundWindowEndsAt is settlement plus the configured window', () => {
    expect(refundWindowEndsAt(1_000n, 5n)).toBe(1_005n)
  })
})
