/** One demo campaign: creator wallet, goal (ALGO), days until deadline, backer pledge (ALGO) or 0. */
export interface SeedCampaign {
  creator: string
  goalAlgo: number
  days: number
  pledgeAlgo: number
}

/** Campaigns to create on LocalNet: creator wallet, goal (ALGO), days until deadline, backer pledge (ALGO) or 0. */
export const CAMPAIGNS_LOCALNET: ReadonlyArray<SeedCampaign> = [
  { creator: 'alice', goalAlgo: 10, days: 1, pledgeAlgo: 4 },
  { creator: 'bob', goalAlgo: 25, days: 1, pledgeAlgo: 0 },
  { creator: 'carol', goalAlgo: 50, days: 1, pledgeAlgo: 18 },
  { creator: 'dave', goalAlgo: 5, days: 1, pledgeAlgo: 0 },
]

// Faucet-friendly amounts for shared networks (one backer needs ~1.6 ALGO total; two creators need ~0.7 ALGO
// each for the creation MBR + registration deposit + fees).
export const CAMPAIGNS_TESTNET: ReadonlyArray<SeedCampaign> = [
  { creator: 'alice', goalAlgo: 2, days: 1, pledgeAlgo: 0.5 },
  { creator: 'carol', goalAlgo: 5, days: 1, pledgeAlgo: 1 },
]
