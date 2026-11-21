/** Typed scale knobs shared by the contract integration scenarios. */
export interface ScaleConfig {
  /** Distinct creators; the many-campaign scenario cycles them across campaigns. */
  readonly creators: number
  /** Campaigns created by the many-campaign scenario. */
  readonly campaigns: number
  /** Distinct backers; the scale scenario splits them across campaigns. */
  readonly backers: number
  /** Pledges each backer makes in the scale scenario. */
  readonly pledgesPerBacker: number
  /** Largest tree the seeded sequence grows to. */
  readonly maxN: number
  /** First sequence seed. */
  readonly seed: number
  /** Number of sequence seeds to run. */
  readonly seedCount: number
}

const NORMAL: ScaleConfig = {
  creators: 10,
  campaigns: 10,
  backers: 5,
  pledgesPerBacker: 1,
  maxN: 100,
  seed: 1,
  seedCount: 1,
}

const HEAVY: ScaleConfig = {
  creators: 25,
  campaigns: 25,
  backers: 100,
  pledgesPerBacker: 1,
  // shortcut: 512 keeps three seeds under the 10-minute scale budget; the 06 ladder covers 1,024.
  maxN: 512,
  seed: 1,
  seedCount: 3,
}

function integerFromEnv(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name}=${raw} must be an integer >= ${minimum.toString()}`)
  }
  return value
}

/**
 * The active scale config for a lane. Every field can be overridden with
 * `KASAKAME_CREATORS`, `KASAKAME_CAMPAIGNS`, `KASAKAME_BACKERS`,
 * `KASAKAME_PLEDGES_PER_BACKER`, `KASAKAME_MAX_N`, `KASAKAME_SEED`, or
 * `KASAKAME_SEED_COUNT`.
 *
 * @param lane The preset to start from.
 * @returns The resolved config.
 */
export function scaleConfig(lane: 'normal' | 'heavy'): ScaleConfig {
  const base = lane === 'heavy' ? HEAVY : NORMAL
  return {
    creators: integerFromEnv('KASAKAME_CREATORS', base.creators, 1),
    campaigns: integerFromEnv('KASAKAME_CAMPAIGNS', base.campaigns, 1),
    backers: integerFromEnv('KASAKAME_BACKERS', base.backers, 1),
    pledgesPerBacker: integerFromEnv('KASAKAME_PLEDGES_PER_BACKER', base.pledgesPerBacker, 1),
    maxN: integerFromEnv('KASAKAME_MAX_N', base.maxN, 1),
    seed: integerFromEnv('KASAKAME_SEED', base.seed, 0),
    seedCount: integerFromEnv('KASAKAME_SEED_COUNT', base.seedCount, 1),
  }
}

/**
 * Distinct backers per campaign in the scale scenario.
 *
 * @param config The active config.
 * @returns The backer count per campaign.
 */
export function backersPerCampaign(config: ScaleConfig): number {
  if (config.backers < config.campaigns || config.backers % config.campaigns !== 0) {
    throw new Error(`KASAKAME_BACKERS=${config.backers.toString()} must be a multiple of KASAKAME_CAMPAIGNS=${config.campaigns.toString()}`)
  }
  return config.backers / config.campaigns
}

/**
 * @param config The active config.
 * @returns One line naming the active scale, for failure output.
 */
export function describeScale(config: ScaleConfig): string {
  return [
    `scale creators=${config.creators.toString()}`,
    `campaigns=${config.campaigns.toString()}`,
    `backers=${config.backers.toString()}`,
    `pledgesPerBacker=${config.pledgesPerBacker.toString()}`,
    `maxN=${config.maxN.toString()}`,
    `seed=${config.seed.toString()}`,
    `seeds=${config.seedCount.toString()}`,
  ].join(' ')
}
