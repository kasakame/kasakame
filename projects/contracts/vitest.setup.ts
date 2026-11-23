import { addEqualityTesters } from '@algorandfoundation/algorand-typescript-testing'
import { configureTestLogging } from '@kasakame/utils/testing'
import { beforeAll, expect } from 'vitest'

configureTestLogging()

// Compare Algorand types (uint64, bytes, accounts) with native JS values, e.g. `expect(raised.value).toEqual(1_000_000)`.
beforeAll(() => {
  addEqualityTesters({ expect })
})
