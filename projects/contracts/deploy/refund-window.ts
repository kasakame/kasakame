import { MAX_REFUND_WINDOW_SECONDS, MIN_REFUND_WINDOW_SECONDS, SECONDS_PER_DAY } from '@kasakame/constants/source'

/** Default refund window: 730 days, per the spec recommendation. */
export const DEFAULT_REFUND_WINDOW_SECONDS = BigInt(730 * SECONDS_PER_DAY)

/**
 * Parse and sanity-check `REFUND_WINDOW_SECONDS`.
 *
 * @param value The raw environment value, if any.
 * @returns The validated window in seconds.
 */
export function parseRefundWindow(value: string | undefined): bigint {
  if (value === undefined || value === '') {
    return DEFAULT_REFUND_WINDOW_SECONDS
  }

  let seconds: bigint
  try {
    seconds = BigInt(value)
  } catch {
    throw new Error('REFUND_WINDOW_SECONDS must be an integer number of seconds.')
  }
  if (seconds < BigInt(MIN_REFUND_WINDOW_SECONDS) || seconds > BigInt(MAX_REFUND_WINDOW_SECONDS)) {
    throw new Error(
      `REFUND_WINDOW_SECONDS must be between ${MIN_REFUND_WINDOW_SECONDS.toString()} (30 days) and ${MAX_REFUND_WINDOW_SECONDS.toString()} seconds.`,
    )
  }
  return seconds
}

/**
 * Resolve the vault's `sweepTarget`: the deployer on LocalNet, an explicit disclosed treasury elsewhere.
 *
 * @param value The raw `SWEEP_TARGET` environment value, if any.
 * @param deployer The deployer address (the LocalNet default).
 * @param isLocalNet Whether the target network is LocalNet.
 * @returns The sweep target address.
 */
export function resolveSweepTarget(value: string | undefined, deployer: string, isLocalNet: boolean): string {
  if (value !== undefined && value !== '') {
    return value
  }
  if (isLocalNet) {
    return deployer
  }
  throw new Error('SWEEP_TARGET is not set - set it to the treasury address that receives unclaimed refunds after the window.')
}
