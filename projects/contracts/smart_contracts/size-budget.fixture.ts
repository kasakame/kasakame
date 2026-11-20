/**
 * Pinned compiled sizes, schemas, and app MBR per contract.
 *
 * Update this fixture and `docs/limits.md` together when a contract changes.
 */
export const SIZE_BUDGET = {
  campaign: {
    contract: 'Campaign',
    approval: 2_245,
    clear: 4,
    total: 2_249,
    extraPages: 1,
    pageCapacity: 4_096,
    globalBytes: 4,
    globalInts: 6,
    appMbr: 571_000,
  },
  claimsvault: {
    contract: 'ClaimsVault',
    approval: 2_856,
    clear: 4,
    total: 2_860,
    extraPages: 1,
    pageCapacity: 4_096,
    globalBytes: 1,
    globalInts: 2,
    appMbr: 307_000,
  },
  registry: {
    contract: 'Registry',
    approval: 954,
    clear: 4,
    total: 958,
    extraPages: 0,
    pageCapacity: 2_048,
    globalBytes: 3,
    globalInts: 2,
    appMbr: 307_000,
  },
} as const
