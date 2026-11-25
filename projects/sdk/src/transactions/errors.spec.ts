import { LogicError } from '@algorandfoundation/algokit-utils/types/logic-error'
import { describe, expect, it } from 'vitest'
import { CONTRACT_ERROR_MESSAGES } from '../generated/contract-errors.js'
import {
  classifyChainError,
  isAlreadyRegisteredError,
  isCampaignRoutingError,
  isStaleProofError,
  SdkError,
  submitWithClassification,
  submitWithFreshProof,
} from './errors.js'

function logicError(message: string, txId = 'TX'): LogicError {
  return new LogicError({ txId, pc: 1, msg: message, desc: 'desc', traces: [] }, ['#pragma'], () => 1)
}

describe('SdkError', () => {
  it('carries the type, code, context, cause, and details', () => {
    const cause = new Error('boom')
    const error = new SdkError('chain-state', 'boom', {
      code: 'some-code',
      operation: 'claim',
      appId: 42n,
      txId: 'TX',
      cause,
      details: { raw: true },
    })

    expect(error).toMatchObject({
      name: 'SdkError',
      message: 'boom',
      type: 'chain-state',
      code: 'some-code',
      operation: 'claim',
      appId: 42n,
      txId: 'TX',
    })
    expect(error.cause).toBe(cause)
    expect(error.details).toEqual({ raw: true })
  })

  it('leaves absent options undefined', () => {
    const error = new SdkError('unknown', 'boom')

    expect(error.code).toBeUndefined()
    expect(error.operation).toBeUndefined()
    expect(error.appId).toBeUndefined()
    expect(error.txId).toBeUndefined()
    expect(error.cause).toBeUndefined()
    expect(error.details).toBeUndefined()
  })
})

describe('classifyChainError', () => {
  it('returns an existing SdkError unchanged', () => {
    const error = new SdkError('validation', 'bad input')
    expect(classifyChainError(error)).toBe(error)
  })

  it('classifies a LogicError from its led details and preserves the message', () => {
    const error = logicError('proof does not match root', 'TX9')
    const classified = classifyChainError(error, { operation: 'refund', appId: 42n })

    expect(classified).toBeInstanceOf(SdkError)
    expect(classified).toMatchObject({
      type: 'stale-proof',
      code: 'stale-proof',
      operation: 'refund',
      appId: 42n,
      txId: 'TX9',
      message: error.message,
    })
    expect(classified.cause).toBe(error)
    expect(classified.details).toBe(error)
  })

  it('prefers an explicit transaction id over the led one', () => {
    expect(classifyChainError(logicError('stale or forged frontier'), { txId: 'OVERRIDE' }).txId).toBe('OVERRIDE')
  })

  it('falls back to the error message when the led details are unusable', () => {
    const numericTx = Object.assign(new Error('campaign is not open'), { led: { msg: 'campaign is not open', txId: 7 } })
    expect(classifyChainError(numericTx)).toMatchObject({ type: 'routing', code: 'campaign-not-open' })
    expect(classifyChainError(numericTx).txId).toBeUndefined()

    const noLed = Object.assign(new Error('campaign is not open'), { led: 'nope' })
    expect(classifyChainError(noLed).type).toBe('routing')

    const noMessage = Object.assign(new Error('campaign is not open'), { led: { msg: 7 } })
    expect(classifyChainError(noMessage).type).toBe('routing')
  })

  it('classifies a generic simulate text by the contract message inside it', () => {
    const error = new Error('transaction ABC: logic eval error: campaign is not open. Details: pc=1')
    expect(classifyChainError(error)).toMatchObject({ type: 'routing', code: 'campaign-not-open' })
  })

  it('uses an explicit code for the SDK max-size guard', () => {
    const error = new Error('campaign reached its maximum size; it can no longer accept pledges')
    expect(classifyChainError(error)).toMatchObject({ type: 'chain-state', code: 'campaign-max-size' })
  })

  it('generates a stable code for a contract assert without an explicit mapping', () => {
    expect(classifyChainError(new Error('only the creator can claim'))).toMatchObject({
      type: 'chain-state',
      code: 'only-the-creator-can-claim',
    })
  })

  it('classifies not-found and network failures', () => {
    const notFound = classifyChainError(new Error('application 123 not found'))
    expect(notFound.type).toBe('not-found')
    expect(notFound.code).toBeUndefined()
    expect(classifyChainError(new Error('application 123 does not exist')).type).toBe('not-found')
    const network = classifyChainError(new Error('fetch failed'))
    expect(network.type).toBe('network')
    expect(network.code).toBeUndefined()
    expect(classifyChainError(new Error('socket hang up')).type).toBe('network')
  })

  it('leaves a non-chain failure unknown and preserves a non-Error message', () => {
    expect(classifyChainError('boom')).toMatchObject({ type: 'unknown', message: 'boom', cause: 'boom', details: 'boom' })
    const unknown = classifyChainError(new Error('boom'))
    expect(unknown.type).toBe('unknown')
    expect(unknown.code).toBeUndefined()
  })

  it('classifies every generated contract assert message', () => {
    const unclassified = CONTRACT_ERROR_MESSAGES.map((message) => ({ message, classified: classifyChainError(new Error(message)) })).filter(
      (entry) => entry.classified.code === undefined || entry.classified.type === 'unknown',
    )

    expect(unclassified).toEqual([])
  })
})

describe('compatibility predicates', () => {
  it('isStaleProofError matches stale proofs only', () => {
    expect(isStaleProofError(new Error('stale or forged frontier'))).toBe(true)
    expect(isStaleProofError(logicError('proof does not match root'))).toBe(true)
    expect(isStaleProofError(new Error('boom'))).toBe(false)
    expect(isStaleProofError('boom')).toBe(false)
  })

  it('isCampaignRoutingError matches routing and not-found failures', () => {
    expect(isCampaignRoutingError(new Error('campaign is not open'))).toBe(true)
    expect(isCampaignRoutingError(new Error('application 9 not found'))).toBe(true)
    expect(isCampaignRoutingError(new Error('boom'))).toBe(false)
  })

  it('isAlreadyRegisteredError matches the registration assert only', () => {
    expect(isAlreadyRegisteredError(new Error('campaign already registered'))).toBe(true)
    expect(isAlreadyRegisteredError(new Error('boom'))).toBe(false)
  })
})

describe('submission wrappers', () => {
  it('submitWithClassification returns the result or throws a typed failure', async () => {
    await expect(submitWithClassification('claim', () => Promise.resolve('ok'), 9n)).resolves.toBe('ok')

    const withApp = await submitWithClassification('claim', () => Promise.reject(new Error('campaign is not open')), 9n).catch(
      (error: unknown) => error,
    )
    expect(withApp).toMatchObject({ type: 'routing', operation: 'claim', appId: 9n })

    const withoutApp = await submitWithClassification('createCampaign', () => Promise.reject(new Error('boom'))).catch(
      (error: unknown) => error,
    )
    expect(withoutApp).toBeInstanceOf(SdkError)
    expect(withoutApp).toMatchObject({ type: 'unknown', operation: 'createCampaign' })
    expect((withoutApp as SdkError).appId).toBeUndefined()
  })

  it('submitWithFreshProof retries a stale proof once', async () => {
    let calls = 0
    const run = (): Promise<string> => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('stale or forged frontier'))
      return Promise.resolve('ok')
    }

    await expect(submitWithFreshProof(run, 'pledge', 9n)).resolves.toBe('ok')
    expect(calls).toBe(2)
  })

  it('submitWithFreshProof surfaces a second stale proof', async () => {
    const failure = await submitWithFreshProof(() => Promise.reject(new Error('stale or forged frontier')), 'cancelPledge', 9n).catch(
      (error: unknown) => error,
    )

    expect(failure).toMatchObject({ type: 'stale-proof', operation: 'cancelPledge', appId: 9n })
  })

  it('submitWithFreshProof does not retry another failure', async () => {
    let calls = 0
    const failure = await submitWithFreshProof(
      () => {
        calls += 1
        return Promise.reject(new Error('boom'))
      },
      'refund',
      9n,
    ).catch((error: unknown) => error)

    expect(failure).toMatchObject({ type: 'unknown', operation: 'refund', appId: 9n })
    expect(calls).toBe(1)
  })
})
