import { Bytes, type Application } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext, toExternalValue } from '@algorandfoundation/algorand-typescript-testing'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, test } from 'vitest'
import { Campaign } from '../campaign/contract.algo'
import { Factory } from './contract.algo'

/**
 * Behavioral tests for the Factory registry, run against the offline AVM emulation provided by `algorand-typescript-testing`.
 *
 * `register()` verifies the campaign app's approval-program hash against the owner-configured official hash. The full LocalNet round trip
 * (deploy a real Campaign, hash its compiled program, register, unregister) lives in `factory.integration.test.ts`; here every guard branch
 * is covered offline with a synthetic application whose program hash is precomputed in the test.
 */

const REGISTER_MBR = 18_900 // µA - the registration box's minimum balance

// The fake campaign app: an application with a known approval program (preimage), whose SHA-256 we set as the official hash.
const FAKE_APP_ID = 1234
const FAKE_PROGRAM = new Uint8Array([0x6b, 0x61, 0x73, 0x61, 0x6b, 0x61, 0x6d, 0x65]) // "kasakame"
const FAKE_PROGRAM_HASH = createHash('sha256').update(FAKE_PROGRAM).digest('base64')

describe('Factory', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => {
    ctx.reset()
  })

  function createFactory() {
    const contract = ctx.contract.create(Factory)
    contract.create()
    return contract
  }

  function setHash(contract: Factory, hash = Bytes.fromBase64(FAKE_PROGRAM_HASH)) {
    contract.setApprovalHash(hash)
  }

  /**
   * A synthetic application standing in for a newly deployed Campaign. Register it once per test and reuse the returned value.
   *
   * @param creator The campaign app's creator.
   * @param program The app's approval program.
   */
  function campaignApp(creator = ctx.defaultSender, program = FAKE_PROGRAM) {
    return ctx.any.application({ applicationId: FAKE_APP_ID, creator, approvalProgram: Bytes(program) })
  }

  function registerAs(contract: Factory, app: ReturnType<typeof campaignApp>, sender = ctx.defaultSender) {
    const factoryAddress = ctx.ledger.getApplicationForContract(contract).address
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender })]).execute(() => {
      contract.register(app, ctx.any.txn.payment({ sender, receiver: factoryAddress, amount: REGISTER_MBR }))
    })
  }

  /**
   * A real Campaign app with the given globals, registered directly in the Factory's box map.
   *
   * `unregister` reads the campaign's state; this helper avoids recomputing the compiled Campaign hash just to register
   * the fixture app.
   *
   * @param contract The factory.
   * @param fields The campaign globals that gate unregistration.
   * @param fields.status Campaign status: 0 Open, 1 Failed, 2 Claimed.
   * @param fields.raised Live pledge total.
   * @param fields.goal Funding target.
   * @param fields.deadline Deadline timestamp.
   * @returns The registered campaign app.
   */
  function registeredCampaign(contract: Factory, fields: { status: number; raised: number; goal: number; deadline: number }): Application {
    const campaign = ctx.contract.create(Campaign)
    campaign.status.value = fields.status
    campaign.raised.value = fields.raised
    campaign.goal.value = fields.goal
    campaign.deadline.value = fields.deadline
    const app = ctx.ledger.getApplicationForContract(campaign)
    contract.registered(app.id).value = ctx.defaultSender
    return app
  }

  /**
   * Call `isRegistered` inside a transaction scope and return the decoded boolean.
   *
   * @param contract The factory.
   * @param app The campaign app.
   */
  function isRegistered(contract: Factory, app: ReturnType<typeof campaignApp>): boolean {
    let result = false
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: ctx.defaultSender })]).execute(() => {
      result = toExternalValue(contract.isRegistered(app) as unknown as string) as unknown as boolean
    })
    return result
  }

  describe('create', () => {
    test('sets the deployer as owner and leaves the approval hash empty', () => {
      const factory = createFactory()
      expect(factory.owner.value).toEqual(ctx.defaultSender)
      expect(factory.approvalHash.value).toEqual(Bytes(''))
    })
  })

  describe('setApprovalHash', () => {
    test('stores the official approval hash', () => {
      const factory = createFactory()
      setHash(factory)
      expect(factory.approvalHash.value).toEqual(Bytes.fromBase64(FAKE_PROGRAM_HASH))
    })

    test('rejects a non-owner caller', () => {
      const factory = createFactory()
      const other = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: other })]).execute(() => {
        expect(() => {
          factory.setApprovalHash(Bytes.fromBase64(FAKE_PROGRAM_HASH))
        }).toThrow('only the owner can set the approval hash')
      })
    })

    test('rejects a hash of the wrong length', () => {
      const factory = createFactory()
      expect(() => {
        factory.setApprovalHash(Bytes('too short'))
      }).toThrow('approval hash must be 32 bytes')
    })
  })

  describe('register', () => {
    test('registers an official campaign and records its creator', () => {
      const factory = createFactory()
      setHash(factory)
      const app = campaignApp()

      registerAs(factory, app)
      expect(factory.registered(FAKE_APP_ID).value).toEqual(ctx.defaultSender)
    })

    test('rejects registration before the official hash is configured', () => {
      const factory = createFactory()
      const app = campaignApp()
      const factoryAddress = ctx.ledger.getApplicationForContract(factory).address
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          factory.register(app, ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: factoryAddress, amount: REGISTER_MBR }))
        }).toThrow('official approval hash not configured')
      })
    })

    test('rejects a non-creator registering someone else’s campaign', () => {
      const factory = createFactory()
      setHash(factory)
      const other = ctx.any.account()
      const app = campaignApp(other)

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          factory.register(
            app,
            ctx.any.txn.payment({
              sender: ctx.defaultSender,
              receiver: ctx.ledger.getApplicationForContract(factory).address,
              amount: REGISTER_MBR,
            }),
          )
        }).toThrow('only the campaign creator can register')
      })
    })

    test('rejects an impostor copy of the Campaign contract', () => {
      const factory = createFactory()
      setHash(factory)
      const app = campaignApp(ctx.defaultSender, new Uint8Array([0x62, 0x61, 0x64]))

      expect(() => {
        registerAs(factory, app)
      }).toThrow('not an official kasakame campaign')
    })

    test('rejects a deposit below the registration minimum balance', () => {
      const factory = createFactory()
      setHash(factory)
      const app = campaignApp()

      const factoryAddress = ctx.ledger.getApplicationForContract(factory).address
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          factory.register(app, ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: factoryAddress, amount: REGISTER_MBR - 1 }))
        }).toThrow('registration deposit too small')
      })
    })

    test('rejects a deposit paid by someone else', () => {
      const factory = createFactory()
      setHash(factory)
      const app = campaignApp()
      const other = ctx.any.account()

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          factory.register(
            app,
            ctx.any.txn.payment({ sender: other, receiver: ctx.ledger.getApplicationForContract(factory).address, amount: REGISTER_MBR }),
          )
        }).toThrow('payment must come from the caller')
      })
    })

    test('rejects a deposit paid to the wrong receiver', () => {
      const factory = createFactory()
      setHash(factory)
      const app = campaignApp()

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          factory.register(app, ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: ctx.defaultSender, amount: REGISTER_MBR }))
        }).toThrow('payment must be made to the factory')
      })
    })

    test('rejects double registration of the same campaign', () => {
      const factory = createFactory()
      setHash(factory)
      const app = campaignApp()
      registerAs(factory, app)

      expect(() => {
        registerAs(factory, app)
      }).toThrow('campaign already registered')
    })

    test('rejects reusing one payment for a second registration in the same group', () => {
      const factory = createFactory()
      setHash(factory)
      const appA = campaignApp()
      const appB = ctx.any.application({
        applicationId: 5678,
        creator: ctx.defaultSender,
        approvalProgram: Bytes(FAKE_PROGRAM),
      })
      const factoryAddress = ctx.ledger.getApplicationForContract(factory).address
      const pay = ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: factoryAddress, amount: REGISTER_MBR })
      const group = [
        pay,
        ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender }),
        ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender }),
      ]
      ctx.txn.createScope(group, 1).execute(() => {
        expect(() => {
          factory.register(appA, pay)
        }).toThrow('register must be the final transaction in the group')
      })
      ctx.txn.createScope(group, 2).execute(() => {
        factory.register(appB, pay)
      })

      expect(factory.registered(FAKE_APP_ID).exists).toBe(false)
      expect(factory.registered(5678).exists).toBe(true)
    })
  })

  describe('unregister', () => {
    test('returns the deposit and removes the registration for a pristine campaign', () => {
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 0, raised: 0, goal: 1000, deadline: 0 })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        factory.unregister(app)
      })

      expect(factory.registered(app.id).exists).toBe(false)
      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payout.receiver).toEqual(ctx.defaultSender)
      expect(payout.amount).toEqual(REGISTER_MBR)
    })

    test('rejects an unregistered campaign', () => {
      const factory = createFactory()
      const app = campaignApp()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          factory.unregister(app)
        }).toThrow('campaign is not registered')
      })
    })

    test('rejects a non-creator unregistering a campaign', () => {
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 2, raised: 1000, goal: 1000, deadline: 0 })

      const other = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: other })]).execute(() => {
        expect(() => {
          factory.unregister(app)
        }).toThrow('only the campaign creator can unregister')
      })
    })

    test('rejects unregistering a live campaign', () => {
      ctx.ledger.patchGlobalData({ latestTimestamp: 1_000 })
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 0, raised: 100, goal: 1000, deadline: 2_000 })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          factory.unregister(app)
        }).toThrow('campaign is still live')
      })
    })

    test('allows a failed-in-fact campaign', () => {
      ctx.ledger.patchGlobalData({ latestTimestamp: 2_000 })
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 0, raised: 100, goal: 1000, deadline: 2_000 })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        factory.unregister(app)
      })
      expect(factory.registered(app.id).exists).toBe(false)
    })

    test('allows a failed campaign', () => {
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 1, raised: 100, goal: 1000, deadline: 2_000 })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        factory.unregister(app)
      })
      expect(factory.registered(app.id).exists).toBe(false)
    })

    test('allows a claimed campaign', () => {
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 2, raised: 1000, goal: 1000, deadline: 2_000 })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        factory.unregister(app)
      })
      expect(factory.registered(app.id).exists).toBe(false)
    })

    test('rejects an app whose campaign state is missing', () => {
      const factory = createFactory()
      const app = campaignApp()
      factory.registered(app.id).value = ctx.defaultSender

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          factory.unregister(app)
        }).toThrow('campaign state missing')
      })
    })
  })

  describe('isRegistered', () => {
    test('reflects registration state', () => {
      const factory = createFactory()
      setHash(factory)
      const app = campaignApp()

      expect(isRegistered(factory, app)).toBe(false)

      registerAs(factory, app)
      expect(isRegistered(factory, app)).toBe(true)
    })
  })
})
