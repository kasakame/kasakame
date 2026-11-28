import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import {
  clearTreeCache,
  createCampaign,
  fetchCampaignHeader,
  fetchChainTimestamp,
  fetchMyLeaves,
  fetchVaultBox,
  waitForIndexerCatchUp,
  type BackerLeaf,
  type CampaignHeader,
  type VaultBoxView,
  type WalletSession,
} from '@kasakame/sdk'
import { advanceTime } from '@kasakame/utils/testing'

/** Chain-relative deadline used by the CLI LocalNet fixtures. */
export const TEST_DEADLINE_SECONDS = 90_000n

/** Campaign overrides for {@link createTestCampaign}. */
export interface TestCampaignOptions {
  /** Absolute deadline; defaults to chain time plus {@link TEST_DEADLINE_SECONDS}. */
  deadline?: bigint
  title?: string
  uri?: string
}

/**
 * Create a campaign with a chain-relative deadline through the SDK, the same path the CLI's users take.
 *
 * @param creator The creator wallet session.
 * @param goalMicroAlgos The funding goal.
 * @param options Campaign overrides.
 * @returns The SDK create result.
 */
export async function createTestCampaign(
  creator: WalletSession,
  goalMicroAlgos: bigint,
  options: TestCampaignOptions = {},
): Promise<Awaited<ReturnType<typeof createCampaign>>> {
  const deadline = options.deadline ?? (await fetchChainTimestamp()) + TEST_DEADLINE_SECONDS
  return createCampaign(creator, options.title ?? 'CLI test campaign', options.uri ?? 'ipfs://cli-test', goalMicroAlgos, deadline)
}

/**
 * Advance the dev-mode clock to a target timestamp.
 *
 * @param fixture The Algorand fixture.
 * @param timestamp The target UNIX timestamp.
 */
export async function advanceTo(fixture: AlgorandFixture, timestamp: bigint): Promise<void> {
  const now = await fetchChainTimestamp()
  const seconds = Number(timestamp - now)
  if (seconds > 0) await advanceTime(fixture, seconds)
}

/**
 * Advance the dev-mode clock to just past a deadline.
 *
 * @param fixture The Algorand fixture.
 * @param deadline The campaign deadline.
 */
export async function advancePastDeadline(fixture: AlgorandFixture, deadline: bigint): Promise<void> {
  await advanceTo(fixture, deadline + 1n)
}

/**
 * Fetch a campaign header after the indexer catches up.
 *
 * @param appId Campaign application id.
 * @returns The header, or undefined when the app is unknown.
 */
export async function headerOf(appId: bigint): Promise<CampaignHeader | undefined> {
  await waitForIndexerCatchUp()
  return fetchCampaignHeader(appId)
}

/**
 * Fetch an address's live leaves after the indexer catches up.
 *
 * @param appId Campaign application id.
 * @param address The viewer.
 * @returns The live leaves.
 */
export async function leavesOf(appId: bigint, address: string): Promise<BackerLeaf[]> {
  // Each CLI run is a separate process; drop the test-process memo so a spend it just landed is visible.
  clearTreeCache()
  await waitForIndexerCatchUp()
  return fetchMyLeaves(appId, address)
}

/** The CLI-visible state a rejected command must leave untouched. */
export interface CliCampaignState {
  header: CampaignHeader | undefined
  leaves: BackerLeaf[]
  box: VaultBoxView | undefined
}

/**
 * Snapshot the campaign header, the viewer's leaves, and the vault box from a fresh indexer read.
 *
 * @param appId Campaign application id.
 * @param address The viewer whose leaves matter.
 * @returns The comparable campaign state.
 */
export async function campaignState(appId: bigint, address: string): Promise<CliCampaignState> {
  clearTreeCache()
  await waitForIndexerCatchUp()
  return {
    header: await fetchCampaignHeader(appId),
    leaves: await fetchMyLeaves(appId, address),
    box: await fetchVaultBox(appId),
  }
}
