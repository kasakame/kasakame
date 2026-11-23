import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import { MICRO_ALGOS_PER_ALGO } from '@kasakame/constants/source'

/**
 * Fund any address on LocalNet from the dispenser (test accounts start at 0 ALGO); LocalNet only.
 */
void (async () => {
  const address = process.env.ADDRESS
  if (address === undefined || address === '') {
    throw new Error('ADDRESS must be set (the account to fund).')
  }
  const algo = process.env.ALGO !== undefined && process.env.ALGO !== '' ? BigInt(process.env.ALGO) : 100n

  const algorand = AlgorandClient.defaultLocalNet()
  const dispenser = await algorand.account.localNetDispenser()
  await algorand.send.payment({ sender: dispenser.addr, receiver: address, amount: microAlgos(algo * MICRO_ALGOS_PER_ALGO) })

  const info = await algorand.account.getInformation(address)
  console.log(`funded ${address} balance=${String(info.balance.microAlgo)}`)
})()
