import type { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing'
import { advanceTime } from '@kasakame/utils/testing'
import { expect } from 'vitest'
import type { BackerLeaf, CampaignHeader, VaultBoxView, WalletSession } from '../../src/index.js'
import { clearTreeCache, createCampaign, fetchCampaignHeader, fetchChainTimestamp, fetchMyLeaves, fetchVaultBox } from '../../src/index.js'

/** Chain-relative deadline used by the SDK LocalNet fixtures. */
export const TEST_DEADLINE_SECONDS = 90_000n

const DEFAULT_TITLE = 'SDK test campaign'
const DEFAULT_URI = 'ipfs://sdk-test-campaign'

/** Campaign overrides for {@link createTestCampaign}. */
export interface TestCampaignOptions {
  title?: string
  uri?: string
  /** Absolute deadline; defaults to chain time plus {@link TEST_DEADLINE_SECONDS}. */
  deadline?: bigint
}

/**
 * Create a campaign with the standard title/URI and a chain-relative deadline.
 *
 * @param session The creator session.
 * @param goalMicroAlgos The funding goal.
 * @param options Campaign overrides.
 * @returns The SDK create result.
 */
export async function createTestCampaign(
  session: WalletSession,
  goalMicroAlgos: bigint,
  options: TestCampaignOptions = {},
): Promise<Awaited<ReturnType<typeof createCampaign>>> {
  const deadline = options.deadline ?? (await fetchChainTimestamp()) + TEST_DEADLINE_SECONDS
  return createCampaign(session, options.title ?? DEFAULT_TITLE, options.uri ?? DEFAULT_URI, goalMicroAlgos, deadline)
}

/**
 * Advance the dev-mode clock just past the standard test deadline.
 *
 * @param fixture The Algorand fixture.
 * @param seconds The deadline offset to pass; defaults to {@link TEST_DEADLINE_SECONDS}.
 */
export async function advancePastDeadline(fixture: AlgorandFixture, seconds = TEST_DEADLINE_SECONDS): Promise<void> {
  await advanceTime(fixture, Number(seconds) + 1)
}

/**
 * Fetch a campaign header, throwing when the indexer has not caught up.
 *
 * @param appId Campaign application id.
 * @returns The campaign header.
 */
export async function headerOf(appId: bigint): Promise<CampaignHeader> {
  const header = await fetchCampaignHeader(appId)
  if (header === undefined) throw new Error(`campaign ${appId.toString()} was not indexed`)
  return header
}

/**
 * Find a leaf by position, throwing when it is missing.
 *
 * @param leaves The viewer's leaves.
 * @param position Leaf position.
 * @returns The matching leaf.
 */
export function leafAt(leaves: BackerLeaf[], position: number): BackerLeaf {
  const leaf = leaves.find((candidate) => candidate.position === position)
  if (leaf === undefined) throw new Error(`leaf ${position.toString()} missing`)
  return leaf
}

/**
 * Assert the viewer's live leaves, ignoring fields unrelated to position and amount.
 *
 * @param leaves The viewer's leaves.
 * @param expected The expected positions and amounts.
 */
export function expectLeaves(leaves: BackerLeaf[], expected: { position: number; amount: bigint }[]): void {
  expect(leaves.map(({ position, amount }) => ({ position, amount }))).toEqual(expected)
}

/**
 * Assert the selected vault-box fields.
 *
 * @param box The vault box, or undefined when it is missing.
 * @param expected The fields that must match.
 */
export function expectVaultBox(box: VaultBoxView | undefined, expected: Partial<VaultBoxView>): void {
  expect(box).toMatchObject(expected)
}

/** The SDK-visible state a rejected call must leave untouched. */
export interface CampaignSnapshot {
  leaves: BackerLeaf[]
  box: VaultBoxView | undefined
  raised: bigint
}

/**
 * Snapshot the viewer's leaves, the vault box, and the raised total from a fresh indexer read.
 *
 * @param appId Campaign application id.
 * @param address The viewer's address.
 * @returns The comparable campaign state.
 */
export async function campaignSnapshot(appId: bigint, address: string): Promise<CampaignSnapshot> {
  clearTreeCache()
  return {
    leaves: await fetchMyLeaves(appId, address),
    box: await fetchVaultBox(appId),
    raised: (await headerOf(appId)).raisedMicroAlgos,
  }
}
