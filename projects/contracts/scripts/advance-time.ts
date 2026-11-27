import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'

/**
 * Moves the LocalNet clock by `SECONDS` (replaces the current offset; 0 resets) and mines a block; LocalNet only.
 */
void (async () => {
  const seconds = process.env.SECONDS
  if (seconds === undefined || seconds === '') {
    throw new Error('SECONDS must be set (offset from real time, e.g. 2592000 for 30 days; 0 resets).')
  }

  const algorand = AlgorandClient.defaultLocalNet()
  const dispenser = await algorand.account.localNetDispenser()
  await algorand.client.algod.setBlockOffsetTimestamp(Number(seconds)).do()
  // Mine a block so the new time takes effect immediately.
  await algorand.send.payment({ sender: dispenser.addr, receiver: dispenser.addr, amount: microAlgos(1000n) })

  const status = await algorand.client.algod.status().do()
  const block = await algorand.client.algod.block(status.lastRound).headerOnly(true).do()
  console.log(
    `round ${String(status.lastRound)} chain time: ${new Date(Number(block.block.header.timestamp) * 1000).toISOString()} (offset ${seconds}s)`,
  )
})()
