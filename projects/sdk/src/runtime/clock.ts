import { getSdkConfig } from './config.js'

/**
 * The chain's current timestamp (latest block header), in seconds; wall-clock time is wrong on time-traveled chains and can drift from consensus.
 *
 * @returns UNIX timestamp in seconds.
 */
export async function fetchChainTimestamp(): Promise<bigint> {
  const algod = getSdkConfig().algorand.client.algod
  const status = await algod.status().do()
  const block = await algod.block(status.lastRound).headerOnly(true).do()
  return block.block.header.timestamp
}
