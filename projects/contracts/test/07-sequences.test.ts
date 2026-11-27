import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, describe, test } from 'vitest'
import { deployStack, type ContractStack } from './utils'
import { scaleConfig } from './utils/scale'
import { runSequence } from './utils/sequence'

const scale = scaleConfig('heavy')

describe('07 seeded sequences', () => {
  const fixture = algorandFixture()
  let stack: ContractStack

  beforeAll(async () => {
    stack = await deployStack(fixture)
  })

  test('CON-230 seeded pledge/cancel/refund/finalize sequences', { tags: ['scale', 'happy', 'always'] }, async () => {
    for (let i = 0; i < scale.seedCount; i++) {
      await runSequence(fixture, stack, scale, scale.seed + i)
    }
  })
})
