import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import {
  accountInfo,
  appSnapshot,
  assertRejectedUnchanged,
  type AccountAmounts,
  type AppSnapshot,
  type CampaignBox,
} from '@kasakame/utils/testing'
import { campaignBox, campaignBoxExists } from './state'

/** The stack surface a rejection snapshot needs. */
export interface RejectionHarness {
  algorand: AlgorandClient
  vault: { client: AppClient }
}

/** Optional state a rejected call must leave untouched. */
export interface RejectionStateOptions {
  /** Addresses whose balances and minimum balances must not change. */
  accounts?: string[]
  /** Campaign app id whose vault box must not change. */
  campaignBox?: bigint
}

/** A comparable app/box/account snapshot. */
export interface RejectionState {
  app: AppSnapshot | undefined
  accounts: Record<string, AccountAmounts>
  box: CampaignBox | undefined
}

// A deleted app is a valid baseline for a rejection; only a missing app is swallowed.
function isMissingApp(error: unknown): boolean {
  return error instanceof Error && /application (\d+ )?does not exist|404/i.test(error.message)
}

async function existingAppSnapshot(algorand: AlgorandClient, appId: bigint): Promise<AppSnapshot | undefined> {
  try {
    return await appSnapshot(algorand, appId)
  } catch (error) {
    if (isMissingApp(error)) return undefined
    throw error
  }
}

/**
 * Snapshot an app, optional account balances, and an optional campaign box.
 *
 * @param harness The deployed stack.
 * @param appId The app expected to stay unchanged.
 * @param options Extra state to snapshot.
 * @returns The comparable state.
 */
export async function rejectionState(
  harness: RejectionHarness,
  appId: bigint,
  options: RejectionStateOptions = {},
): Promise<RejectionState> {
  const addresses = options.accounts ?? []
  const entries = await Promise.all(addresses.map(async (address) => [address, await accountInfo(harness.algorand, address)] as const))
  let box: CampaignBox | undefined
  if (options.campaignBox !== undefined && (await campaignBoxExists(harness.vault.client, options.campaignBox))) {
    box = await campaignBox(harness.vault.client, options.campaignBox)
  }
  return {
    app: await existingAppSnapshot(harness.algorand, appId),
    accounts: Object.fromEntries(entries),
    box,
  }
}

/**
 * Assert a send rejects and leaves the app, accounts, and campaign box unchanged.
 *
 * @param harness The deployed stack.
 * @param appId The app expected to stay unchanged.
 * @param action The call expected to fail.
 * @param error Optional pattern the rejection must match.
 * @param options Extra state to snapshot.
 */
export async function expectSendRejected(
  harness: RejectionHarness,
  appId: bigint,
  action: () => Promise<unknown>,
  error?: RegExp,
  options: RejectionStateOptions = {},
): Promise<void> {
  await assertRejectedUnchanged(action, () => rejectionState(harness, appId, options), error)
}

/**
 * Send a composed group and assert it is rejected without changing the app, accounts, or campaign box.
 *
 * @param harness The deployed stack.
 * @param appId The app under test.
 * @param build Adds the call to a fresh composer.
 * @param error Optional pattern the rejection must match.
 * @param options Extra state to snapshot.
 */
export async function expectRejected(
  harness: RejectionHarness,
  appId: bigint,
  build: (composer: ReturnType<AlgorandClient['send']['newGroup']>) => void,
  error?: RegExp,
  options: RejectionStateOptions = {},
): Promise<void> {
  const composer = harness.algorand.send.newGroup()
  build(composer)
  await expectSendRejected(harness, appId, () => composer.send({ suppressLog: true }), error, options)
}
