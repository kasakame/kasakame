import { Bytes, Global, OnCompleteAction, type Account, type Application } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext, toExternalValue } from '@algorandfoundation/algorand-typescript-testing'
import {
  CAMPAIGN_STATUS_CLAIMED,
  CAMPAIGN_STATUS_FAILED,
  CAMPAIGN_STATUS_OPEN,
  MAX_REFUND_WINDOW_SECONDS,
  MAX_TREE_SIZE,
  MIN_REFUND_WINDOW_SECONDS,
  REGISTER_DEPOSIT_MICRO_ALGOS,
} from '@kasakame/constants'
import { programHash } from '@kasakame/utils'
import { beforeEach, describe, expect, test } from 'vitest'
import { Campaign } from '../campaign/contract.algo'
import { ClaimsVault } from '../claimsvault/contract.algo'
import { Registry } from './contract.algo'

/**
 * Behavioral tests for the ownerless Registry against the offline AVM emulation (create, bindVault, register, unregister).
 */

const FAKE_PROGRAM = new Uint8Array([0x6b, 0x61, 0x73, 0x61, 0x6b, 0x61, 0x6d, 0x65]) // "kasakame"
const FAKE_PROGRAM_HASH = programHash(FAKE_PROGRAM, new Uint8Array())
const TITLE = Bytes('Test campaign')
const METADATA_URI = Bytes('ipfs://test')
const GOAL = 1_000_000
const DEADLINE = 1_000_000
const DELETE_SELECTOR = Bytes.fromHex('24378d3c')

// Campaign global-state statuses: 0 = Open, 1 = Failed, 2 = Claimed.
const CAMPAIGN_OPEN = Number(CAMPAIGN_STATUS_OPEN)
const CAMPAIGN_FAILED = Number(CAMPAIGN_STATUS_FAILED)
const CAMPAIGN_CLAIMED = Number(CAMPAIGN_STATUS_CLAIMED)

let nextProbeId = 10_000

describe('Registry', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => {
    ctx.reset()
    ctx.ledger.patchGlobalData({ latestTimestamp: 1_000, round: 1_000 })
  })

  /** The official Campaign program hash, from a probe app. */
  function campaignProgramHash(): Uint8Array {
    const vault = ctx.any.application({ applicationId: nextProbeId++ })
    const campaign = ctx.contract.create(Campaign)
    campaign.create(vault, TITLE, METADATA_URI, GOAL, DEADLINE)
    const app = ctx.ledger.getApplicationForContract(campaign)
    return programHash(toExternalValue(app.approvalProgram), toExternalValue(app.clearStateProgram))
  }

  /** The official ClaimsVault program hash, from a probe app. */
  function vaultProgramHash(): Uint8Array {
    const registry = ctx.any.application({ applicationId: nextProbeId++ })
    const vault = ctx.contract.create(ClaimsVault)
    vault.create(registry, ctx.defaultSender, MIN_REFUND_WINDOW_SECONDS)
    const app = ctx.ledger.getApplicationForContract(vault)
    return programHash(toExternalValue(app.approvalProgram), toExternalValue(app.clearStateProgram))
  }

  function createRegistry(
    options: {
      campaignHash?: Uint8Array
      vaultHash?: Uint8Array
      sweep?: Account
      window?: number
    } = {},
  ): Registry {
    const registry = ctx.contract.create(Registry)
    registry.create(
      Bytes(options.campaignHash ?? FAKE_PROGRAM_HASH),
      Bytes(options.vaultHash ?? vaultProgramHash()),
      options.sweep ?? ctx.defaultSender,
      options.window ?? MIN_REFUND_WINDOW_SECONDS,
    )
    return registry
  }

  function createVault(registry: Registry, sweep: Account = ctx.defaultSender, window: number = MIN_REFUND_WINDOW_SECONDS): Application {
    const vault = ctx.contract.create(ClaimsVault)
    vault.create(ctx.ledger.getApplicationForContract(registry), sweep, window)
    // The offline ledger keeps an Application-typed global as an ApplicationCls; the AVM stores the app id as uint64.
    ;(vault.registry as unknown as { value: unknown }).value = ctx.ledger.getApplicationForContract(registry).id
    return ctx.ledger.getApplicationForContract(vault)
  }

  function createCampaign(
    vault: Application,
    fields?: { status: number; raised: number; goal: number; deadline: number; n?: number },
  ): Application {
    const campaign = ctx.contract.create(Campaign)
    campaign.create(vault, TITLE, METADATA_URI, GOAL, DEADLINE)
    // The offline ledger keeps an Application-typed global as an ApplicationCls; the AVM stores the app id as uint64.
    ;(campaign.vault as unknown as { value: unknown }).value = vault.id
    if (fields !== undefined) {
      campaign.status.value = fields.status
      campaign.raised.value = fields.raised
      campaign.goal.value = fields.goal
      campaign.deadline.value = fields.deadline
      campaign.n.value = fields.n ?? 0
    }
    return ctx.ledger.getApplicationForContract(campaign)
  }

  function bind(registry: Registry, vault: Application, sender: Account = ctx.defaultSender): void {
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender })]).execute(() => {
      registry.bindVault(vault)
    })
  }

  function registerAs(registry: Registry, app: Application, sender: Account = ctx.defaultSender): void {
    const address = ctx.ledger.getApplicationForContract(registry).address
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender })]).execute(() => {
      registry.register(app, ctx.any.txn.payment({ sender, receiver: address, amount: Number(REGISTER_DEPOSIT_MICRO_ALGOS) }))
    })
  }

  function isRegistered(registry: Registry, app: Application): boolean {
    let result = false
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender })]).execute(() => {
      result = toExternalValue(registry.isRegistered(app) as unknown as string) as unknown as boolean
    })
    return result
  }

  /**
   * A real Campaign app with the given globals, registered directly in the Registry's box map.
   *
   * @param registry The Registry.
   * @param fields The campaign globals that gate unregistration.
   * @param fields.status Campaign status: 0 Open, 1 Failed, 2 Claimed.
   * @param fields.raised Live pledge total.
   * @param fields.goal Funding target.
   * @param fields.deadline Deadline timestamp.
   * @param fields.n Positions ever appended.
   */
  function registeredCampaign(
    registry: Registry,
    fields: { status: number; raised: number; goal: number; deadline: number; n?: number },
  ): Application {
    const app = createCampaign(ctx.any.application({ applicationId: 777 }), fields)
    registry.registered(app.id).value = ctx.defaultSender
    return app
  }

  function deleteCall(app: Application, sender: Account = ctx.defaultSender) {
    return ctx.any.txn.applicationCall({
      appId: app,
      sender,
      onCompletion: OnCompleteAction.DeleteApplication,
      appArgs: [DELETE_SELECTOR],
    })
  }

  function unregisterWithDelete(registry: Registry, app: Application, sender: Account = ctx.defaultSender): void {
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender }), deleteCall(app, sender)], 0).execute(() => {
      registry.unregister(app)
    })
  }

  describe('create', () => {
    test('stores the immutable bundle and leaves the vault unbound', () => {
      const campaignHash = new Uint8Array(32).fill(0x11)
      const vaultHash = new Uint8Array(32).fill(0x22)
      const registry = createRegistry({ campaignHash, vaultHash })

      expect(Buffer.from(toExternalValue(registry.campaignProgramHash.value))).toEqual(Buffer.from(campaignHash))
      expect(Buffer.from(toExternalValue(registry.vaultProgramHash.value))).toEqual(Buffer.from(vaultHash))
      expect(registry.expectedSweepTarget.value).toEqual(ctx.defaultSender)
      expect(registry.expectedRefundWindow.value).toEqual(MIN_REFUND_WINDOW_SECONDS)
      expect(registry.vault.value).toEqual(0)
    })

    test('rejects a campaign program hash of the wrong length', () => {
      const registry = ctx.contract.create(Registry)
      expect(() => {
        registry.create(Bytes('short'), Bytes(FAKE_PROGRAM_HASH), ctx.defaultSender, MIN_REFUND_WINDOW_SECONDS)
      }).toThrow('campaign program hash must be 32 bytes')
    })

    test('rejects a vault program hash of the wrong length', () => {
      const registry = ctx.contract.create(Registry)
      expect(() => {
        registry.create(Bytes(FAKE_PROGRAM_HASH), Bytes('short'), ctx.defaultSender, MIN_REFUND_WINDOW_SECONDS)
      }).toThrow('vault program hash must be 32 bytes')
    })

    test('rejects a zero sweep target', () => {
      const registry = ctx.contract.create(Registry)
      expect(() => {
        registry.create(Bytes(FAKE_PROGRAM_HASH), Bytes(FAKE_PROGRAM_HASH), Global.zeroAddress, MIN_REFUND_WINDOW_SECONDS)
      }).toThrow('sweep target must not be zero')
    })

    test('rejects the Registry itself as sweep target', () => {
      const registry = ctx.contract.create(Registry)
      const registryApp = ctx.ledger.getApplicationForContract(registry)
      expect(() => {
        registry.create(Bytes(FAKE_PROGRAM_HASH), Bytes(FAKE_PROGRAM_HASH), registryApp.address, MIN_REFUND_WINDOW_SECONDS)
      }).toThrow('sweep target must not be the registry')
    })

    test('rejects a refund window below the 30-day minimum', () => {
      const registry = ctx.contract.create(Registry)
      expect(() => {
        registry.create(Bytes(FAKE_PROGRAM_HASH), Bytes(FAKE_PROGRAM_HASH), ctx.defaultSender, MIN_REFUND_WINDOW_SECONDS - 1)
      }).toThrow('refund window too short')
    })

    test('accepts a refund window exactly at the 30-day minimum', () => {
      const registry = createRegistry({ window: MIN_REFUND_WINDOW_SECONDS })
      expect(registry.expectedRefundWindow.value).toEqual(MIN_REFUND_WINDOW_SECONDS)
    })

    test('accepts a refund window exactly at the 10-year maximum', () => {
      const registry = createRegistry({ window: MAX_REFUND_WINDOW_SECONDS })
      expect(registry.expectedRefundWindow.value).toEqual(MAX_REFUND_WINDOW_SECONDS)
    })

    test('rejects a refund window above the cap', () => {
      const registry = ctx.contract.create(Registry)
      expect(() => {
        registry.create(Bytes(FAKE_PROGRAM_HASH), Bytes(FAKE_PROGRAM_HASH), ctx.defaultSender, MAX_REFUND_WINDOW_SECONDS + 1)
      }).toThrow('refund window too long')
    })

    test('rejects an inner create', () => {
      const registry = ctx.contract.create(Registry)
      ctx.ledger.patchGlobalData({ callerApplicationId: 42 })
      expect(() => {
        registry.create(Bytes(FAKE_PROGRAM_HASH), Bytes(FAKE_PROGRAM_HASH), ctx.defaultSender, MIN_REFUND_WINDOW_SECONDS)
      }).toThrow('must be called from the top level')
    })
  })

  describe('bindVault', () => {
    test('binds the official vault once', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      expect(registry.vault.value).toEqual(vault.id)
      expect(() => {
        bind(registry, vault)
      }).toThrow('vault already bound')
    })

    test('rejects a zero vault id', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      expect(() => {
        bind(registry, ctx.any.application({ applicationId: 0 }))
      }).toThrow('vault required')
    })

    test('rejects a vault bound to another registry', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const otherRegistry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(otherRegistry)
      expect(() => {
        bind(registry, vault)
      }).toThrow('vault is not bound to this registry')
    })

    test('rejects a wrong sweep target', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(registry, ctx.any.account())
      expect(() => {
        bind(registry, vault)
      }).toThrow('vault sweep target mismatch')
    })

    test('rejects a wrong refund window', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash(), window: MIN_REFUND_WINDOW_SECONDS + 1 })
      const vault = createVault(registry, ctx.defaultSender, MIN_REFUND_WINDOW_SECONDS + 2)
      expect(() => {
        bind(registry, vault)
      }).toThrow('vault refund window mismatch')
    })

    test('rejects a lookalike vault program', () => {
      const registry = createRegistry({ vaultHash: FAKE_PROGRAM_HASH })
      const vault = createVault(registry)
      expect(() => {
        bind(registry, vault)
      }).toThrow('not the official vault program')
    })

    test('rejects an empty vault program hash', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      ctx.ledger.setGlobalState(registry, Bytes('vaultProgramHash'), Bytes(''))
      expect(() => {
        bind(registry, vault)
      }).toThrow('vault program hash not configured')
    })

    test('rejects a vault with no registry global', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      expect(() => {
        bind(registry, ctx.any.application({ applicationId: 777 }))
      }).toThrow('vault is not bound to this registry')
    })

    test('rejects an inner bind', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      ctx.ledger.patchGlobalData({ callerApplicationId: 42 })
      expect(() => {
        registry.bindVault(vault)
      }).toThrow('must be called from the top level')
    })
  })

  describe('register', () => {
    test('registers an official campaign bound to the official vault', () => {
      const registry = createRegistry({ campaignHash: campaignProgramHash(), vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const app = createCampaign(vault)

      registerAs(registry, app)
      expect(registry.registered(app.id).value).toEqual(ctx.defaultSender)
      expect(isRegistered(registry, app)).toEqual(true)
      expect(isRegistered(registry, ctx.any.application({ applicationId: 999 }))).toEqual(false)
    })

    test('rejects registration before the official vault is bound', () => {
      const registry = createRegistry({ campaignHash: campaignProgramHash(), vaultHash: vaultProgramHash() })
      const app = createCampaign(ctx.any.application({ applicationId: 777 }))
      expect(() => {
        registerAs(registry, app)
      }).toThrow('official vault not configured')
    })

    test('rejects registration when the campaign program hash is empty', () => {
      const registry = createRegistry({ campaignHash: campaignProgramHash(), vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const app = createCampaign(vault)
      ctx.ledger.setGlobalState(registry, Bytes('campaignProgramHash'), Bytes(''))
      expect(() => {
        registerAs(registry, app)
      }).toThrow('official program hash not configured')
    })

    test('rejects a campaign pointing at a different vault', () => {
      const registry = createRegistry({ campaignHash: campaignProgramHash(), vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const app = createCampaign(ctx.any.application({ applicationId: 777 }))

      expect(() => {
        registerAs(registry, app)
      }).toThrow('campaign vault is not the official vault')
    })

    test('rejects a non-creator registering someone else’s campaign', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const other = ctx.any.account()
      const app = ctx.any.application({
        applicationId: 1234,
        creator: other,
        approvalProgram: Bytes(FAKE_PROGRAM),
        clearStateProgram: Bytes(''),
      })
      expect(() => {
        registerAs(registry, app)
      }).toThrow('only the campaign creator can register')
    })

    test('rejects an impostor campaign program', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const app = ctx.any.application({
        applicationId: 1234,
        creator: ctx.defaultSender,
        approvalProgram: Bytes(new Uint8Array([0x62, 0x61, 0x64])),
        clearStateProgram: Bytes(''),
      })
      expect(() => {
        registerAs(registry, app)
      }).toThrow('not an official kasakame campaign')
    })

    test('rejects a campaign with a custom clear-state program', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const app = ctx.any.application({
        applicationId: 1234,
        creator: ctx.defaultSender,
        approvalProgram: Bytes(FAKE_PROGRAM),
        clearStateProgram: Bytes(new Uint8Array([0x62, 0x61, 0x64])),
      })
      expect(() => {
        registerAs(registry, app)
      }).toThrow('not an official kasakame campaign')
    })

    test('rejects a campaign with no vault global after the hash check', () => {
      const registry = createRegistry({ campaignHash: FAKE_PROGRAM_HASH, vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const app = ctx.any.application({
        applicationId: 1234,
        creator: ctx.defaultSender,
        approvalProgram: Bytes(FAKE_PROGRAM),
        clearStateProgram: Bytes(''),
      })
      expect(() => {
        registerAs(registry, app)
      }).toThrow('campaign vault is not the official vault')
    })

    test('rejects a deposit below the registration minimum balance', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const address = ctx.ledger.getApplicationForContract(registry).address
      const app = ctx.any.application({ applicationId: 1234, creator: ctx.defaultSender })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          registry.register(
            app,
            ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: address, amount: Number(REGISTER_DEPOSIT_MICRO_ALGOS) - 1 }),
          )
        }).toThrow('registration deposit must be exact')
      })
    })

    test('rejects a deposit above the registration minimum balance', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const address = ctx.ledger.getApplicationForContract(registry).address
      const app = ctx.any.application({ applicationId: 1234, creator: ctx.defaultSender })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          registry.register(
            app,
            ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: address, amount: Number(REGISTER_DEPOSIT_MICRO_ALGOS) + 1 }),
          )
        }).toThrow('registration deposit must be exact')
      })
    })

    test('rejects a deposit from someone else', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const address = ctx.ledger.getApplicationForContract(registry).address
      const other = ctx.any.account()
      const app = ctx.any.application({ applicationId: 1234, creator: ctx.defaultSender })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          registry.register(app, ctx.any.txn.payment({ sender: other, receiver: address, amount: Number(REGISTER_DEPOSIT_MICRO_ALGOS) }))
        }).toThrow('payment must come from the caller')
      })
    })

    test('rejects a deposit to the wrong receiver', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const app = ctx.any.application({ applicationId: 1234, creator: ctx.defaultSender })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          registry.register(
            app,
            ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: ctx.defaultSender, amount: Number(REGISTER_DEPOSIT_MICRO_ALGOS) }),
          )
        }).toThrow('payment must be made to the registry')
      })
    })

    test('rejects a deposit that closes or rekeys the sender', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const address = ctx.ledger.getApplicationForContract(registry).address
      const app = ctx.any.application({ applicationId: 1234, creator: ctx.defaultSender })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          registry.register(
            app,
            ctx.any.txn.payment({
              sender: ctx.defaultSender,
              receiver: address,
              amount: Number(REGISTER_DEPOSIT_MICRO_ALGOS),
              closeRemainderTo: address,
            }),
          )
        }).toThrow('payment must not close')
      })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          registry.register(
            app,
            ctx.any.txn.payment({
              sender: ctx.defaultSender,
              receiver: address,
              amount: Number(REGISTER_DEPOSIT_MICRO_ALGOS),
              rekeyTo: ctx.any.account(),
            }),
          )
        }).toThrow('payment must not rekey')
      })
    })

    test('rejects a duplicate registration', () => {
      const registry = createRegistry({ campaignHash: campaignProgramHash(), vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const app = createCampaign(vault)
      registerAs(registry, app)
      expect(() => {
        registerAs(registry, app)
      }).toThrow('campaign already registered')
    })

    test('rejects a register call that is not the group’s final transaction', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const vault = createVault(registry)
      bind(registry, vault)
      const address = ctx.ledger.getApplicationForContract(registry).address
      const app = ctx.any.application({ applicationId: 1234, creator: ctx.defaultSender })
      const pay = ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: address, amount: Number(REGISTER_DEPOSIT_MICRO_ALGOS) })
      const group = [
        pay,
        ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender }),
        ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender }),
      ]
      ctx.txn.createScope(group, 1).execute(() => {
        expect(() => {
          registry.register(app, pay)
        }).toThrow('register must be the final transaction in the group')
      })
    })

    test('rejects an inner register', () => {
      const registry = createRegistry({ vaultHash: vaultProgramHash() })
      const app = ctx.any.application({ applicationId: 1234, creator: ctx.defaultSender })
      ctx.ledger.patchGlobalData({ callerApplicationId: 42 })
      expect(() => {
        registry.register(
          app,
          ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: ctx.defaultSender, amount: Number(REGISTER_DEPOSIT_MICRO_ALGOS) }),
        )
      }).toThrow('must be called from the top level')
    })
  })

  describe('unregister', () => {
    test('returns the deposit and removes the registration for a pristine campaign', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_OPEN, raised: 0, goal: 1000, deadline: 0 })

      unregisterWithDelete(registry, app)

      expect(registry.registered(app.id).exists).toBe(false)
      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payout.receiver).toEqual(ctx.defaultSender)
      expect(payout.amount).toEqual(Number(REGISTER_DEPOSIT_MICRO_ALGOS))
    })

    test('allows an all-cancelled campaign before the deadline', () => {
      ctx.ledger.patchGlobalData({ latestTimestamp: 1_000 })
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_OPEN, raised: 0, goal: 1000, deadline: 2_000, n: 2 })

      unregisterWithDelete(registry, app)
      expect(registry.registered(app.id).exists).toBe(false)
    })

    test('allows a settled failed campaign', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_FAILED, raised: 100, goal: 1000, deadline: 2_000 })
      unregisterWithDelete(registry, app)
      expect(registry.registered(app.id).exists).toBe(false)
    })

    test('allows a claimed campaign', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_CLAIMED, raised: 1000, goal: 1000, deadline: 2_000 })
      unregisterWithDelete(registry, app)
      expect(registry.registered(app.id).exists).toBe(false)
    })

    test('allows a failed-in-fact campaign', () => {
      ctx.ledger.patchGlobalData({ latestTimestamp: 3_000 })
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_OPEN, raised: 100, goal: 1000, deadline: 2_000 })
      unregisterWithDelete(registry, app)
      expect(registry.registered(app.id).exists).toBe(false)
    })

    test('allows a cap-saturated campaign before the deadline', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, {
        status: CAMPAIGN_OPEN,
        raised: 100,
        goal: 1000,
        deadline: 2_000,
        n: Number(MAX_TREE_SIZE),
      })
      unregisterWithDelete(registry, app)
      expect(registry.registered(app.id).exists).toBe(false)
    })

    test('rejects a live campaign', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_OPEN, raised: 100, goal: 1000, deadline: 2_000 })
      expect(() => {
        unregisterWithDelete(registry, app)
      }).toThrow('campaign is still live')
    })

    test('rejects an invalid campaign status', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: 3, raised: 100, goal: 1000, deadline: 2_000 })
      expect(() => {
        unregisterWithDelete(registry, app)
      }).toThrow('invalid campaign status')
    })

    test('rejects a non-creator', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_OPEN, raised: 0, goal: 1000, deadline: 0 })
      const other = ctx.any.account()
      expect(() => {
        ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender: other }), deleteCall(app, other)], 0).execute(() => {
          registry.unregister(app)
        })
      }).toThrow('only the campaign creator can unregister')
    })

    test('rejects a registration box owned by another account', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_OPEN, raised: 0, goal: 1000, deadline: 0 })
      registry.registered(app.id).value = ctx.any.account()
      expect(() => {
        unregisterWithDelete(registry, app)
      }).toThrow('only the campaign creator can unregister')
    })

    test('requires the delete pair for an unregistered campaign and does not pay a deposit', () => {
      const registry = createRegistry()
      const app = ctx.any.application({ applicationId: 1234, creator: ctx.defaultSender })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          registry.unregister(app)
        }).toThrow('delete must follow unregister')
      })
      unregisterWithDelete(registry, app)
      expect(registry.registered(app.id).exists).toBe(false)
    })

    test('rejects a delete for another app', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_OPEN, raised: 0, goal: 1000, deadline: 0 })
      const other = ctx.any.application({ applicationId: 999 })
      expect(() => {
        ctx.txn
          .createScope([ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender }), deleteCall(other)], 0)
          .execute(() => {
            registry.unregister(app)
          })
      }).toThrow('delete must target the campaign')
    })

    test('rejects a delete from another sender', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_OPEN, raised: 0, goal: 1000, deadline: 0 })
      const other = ctx.any.account()
      expect(() => {
        ctx.txn
          .createScope([ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender }), deleteCall(app, other)], 0)
          .execute(() => {
            registry.unregister(app)
          })
      }).toThrow('delete must come from the creator')
    })

    test('rejects a non-delete action', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_OPEN, raised: 0, goal: 1000, deadline: 0 })
      const call = ctx.any.txn.applicationCall({ appId: app, sender: ctx.defaultSender, appArgs: [DELETE_SELECTOR] })
      expect(() => {
        ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender }), call], 0).execute(() => {
          registry.unregister(app)
        })
      }).toThrow('delete must be DeleteApplication')
    })

    test('rejects a delete with missing args', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_OPEN, raised: 0, goal: 1000, deadline: 0 })
      const call = ctx.any.txn.applicationCall({
        appId: app,
        sender: ctx.defaultSender,
        onCompletion: OnCompleteAction.DeleteApplication,
      })
      expect(() => {
        ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender }), call], 0).execute(() => {
          registry.unregister(app)
        })
      }).toThrow('delete args mismatch')
    })

    test('rejects a delete with the wrong selector', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_OPEN, raised: 0, goal: 1000, deadline: 0 })
      const call = ctx.any.txn.applicationCall({
        appId: app,
        sender: ctx.defaultSender,
        onCompletion: OnCompleteAction.DeleteApplication,
        appArgs: [Bytes.fromHex('deadbeef')],
      })
      expect(() => {
        ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: registry, sender: ctx.defaultSender }), call], 0).execute(() => {
          registry.unregister(app)
        })
      }).toThrow('delete selector mismatch')
    })

    test('rejects an inner unregister', () => {
      const registry = createRegistry()
      const app = registeredCampaign(registry, { status: CAMPAIGN_OPEN, raised: 0, goal: 1000, deadline: 0 })
      ctx.ledger.patchGlobalData({ callerApplicationId: 42 })
      expect(() => {
        registry.unregister(app)
      }).toThrow('must be called from the top level')
    })
  })
})
