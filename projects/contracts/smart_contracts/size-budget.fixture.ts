/**
 * Pinned compiled sizes, schemas, and app MBR per contract.
 *
 * Update this fixture and `docs/limits.md` together when a contract changes.
 */
export const SIZE_BUDGET = {
  campaign: {
    contract: 'Campaign',
    approval: 2_145,
    clear: 4,
    total: 2_149,
    extraPages: 1,
    pageCapacity: 4_096,
    globalBytes: 4,
    globalInts: 6,
    appMbr: 571_000,
  },
  claimsvault: {
    contract: 'ClaimsVault',
    approval: 2_789,
    clear: 4,
    total: 2_793,
    extraPages: 1,
    pageCapacity: 4_096,
    globalBytes: 1,
    globalInts: 2,
    appMbr: 307_000,
  },
  factory: {
    contract: 'Factory',
    approval: 1_044,
    clear: 4,
    total: 1_048,
    extraPages: 0,
    pageCapacity: 2_048,
    globalBytes: 4,
    globalInts: 2,
    appMbr: 357_000,
  },
} as const
