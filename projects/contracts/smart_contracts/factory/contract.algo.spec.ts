import { Bytes, OnCompleteAction, type Application } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext, toExternalValue } from '@algorandfoundation/algorand-typescript-testing'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, test } from 'vitest'
import { Campaign } from '../campaign/contract.algo'
import { ClaimsVault } from '../claimsvault/contract.algo'
import { Factory } from './contract.algo'

/**
 * Behavioral tests for the Factory registry, run against the offline AVM emulation provided by `algorand-typescript-testing`.
 *
 * `register()` verifies the campaign app's approval + clear-state program hash against the owner-configured official hash. The full LocalNet round trip
 * (deploy a real Campaign, hash its compiled program, register, unregister) lives in `factory.integration.test.ts`; here every guard branch
 * is covered offline with a synthetic application whose program hash is precomputed in the test.
 */

const REGISTER_MBR = 18_900 // µA - the registration box's minimum balance

/**
 * The official program hash: `sha256(itob(approval.length) ‖ approval ‖ clear)`.
 *
 * @param approval The approval program bytes.
 * @param clear The clear-state program bytes.
 * @returns The base64-encoded SHA-256 digest.
 */
function programHash(approval: Uint8Array, clear: Uint8Array): string {
  const lengthPrefix = Buffer.alloc(8)
  lengthPrefix.writeBigUInt64BE(BigInt(approval.length))
  return createHash('sha256').update(lengthPrefix).update(approval).update(clear).digest('base64')
}

// The fake campaign app: an application with a known approval program (preimage), whose length-prefixed hash we set as the official hash.
const FAKE_APP_ID = 1234
const FAKE_PROGRAM = new Uint8Array([0x6b, 0x61, 0x73, 0x61, 0x6b, 0x61, 0x6d, 0x65]) // "kasakame"
const FAKE_PROGRAM_HASH = programHash(FAKE_PROGRAM, new Uint8Array())

// A non-official vault app id for mismatch tests.
const VAULT_APP_ID = 777

describe('Factory', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => {
    ctx.reset()
    ctx.ledger.patchGlobalData({ latestTimestamp: 1_000 })
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
   * A real ClaimsVault bound back to the given Factory, so `setVault` can verify the binding.
   *
   * @param factory The Factory the vault must point at.
   * @returns The deployed vault application.
   */
  function vaultApp(factory: Factory): Application {
    const vault = ctx.contract.create(ClaimsVault)
    vault.create(ctx.ledger.getApplicationForContract(factory), ctx.defaultSender, 1)
    // The offline ledger keeps an Application-typed global as an ApplicationCls; the AVM stores the app id as uint64.
    ;(vault.factory as unknown as { value: unknown }).value = ctx.ledger.getApplicationForContract(factory).id
    return ctx.ledger.getApplicationForContract(vault)
  }

  /**
   * Bind the Factory's official vault (owner-only, one-time).
   *
   * @param contract The factory.
   * @param vault The official vault app.
   */
  function setVault(contract: Factory, vault: ReturnType<typeof vaultApp>) {
    contract.setVault(vault)
  }

  /**
   * The SHA-256 of a real Campaign app's approval + clear-state programs, exactly what `register` verifies.
   *
   * @param contract The factory.
   * @param app The real Campaign app.
   */
  function setCampaignHash(contract: Factory, app: Application) {
    const hash = programHash(toExternalValue(app.approvalProgram), toExternalValue(app.clearStateProgram))
    setHash(contract, Bytes.fromBase64(hash))
  }

  /**
   * A real Campaign app created with the official vault, so `register` can read its `vault` global.
   *
   * @param vault The vault app stored in the campaign's global state.
   * @returns The deployed Campaign application.
   */
  function realCampaign(vault: ReturnType<typeof vaultApp>): Application {
    const campaign = ctx.contract.create(Campaign)
    campaign.create(vault, Bytes('Test campaign'), Bytes('ipfs://test'), 1_000, 4_000_000_000)
    // The offline ledger keeps an Application-typed global as an ApplicationCls; the AVM stores the app id as uint64.
    ;(campaign.vault as unknown as { value: unknown }).value = vault.id
    return ctx.ledger.getApplicationForContract(campaign)
  }

  /**
   * A synthetic application standing in for a newly deployed Campaign. Register it once per test and reuse the returned value.
   *
   * @param creator The campaign app's creator.
   * @param program The app's approval program.
   * @param clearProgram The app's clear-state program.
   */
  function campaignApp(creator = ctx.defaultSender, program = FAKE_PROGRAM, clearProgram = new Uint8Array()) {
    return ctx.any.application({
      applicationId: FAKE_APP_ID,
      creator,
      approvalProgram: Bytes(program),
      clearStateProgram: Bytes(clearProgram),
    })
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
   * @param fields.n Positions ever appended (non-zero for an all-cancelled campaign).
   * @returns The registered campaign app.
   */
  function registeredCampaign(
    contract: Factory,
    fields: { status: number; raised: number; goal: number; deadline: number; n?: number },
  ): Application {
    const campaign = ctx.contract.create(Campaign)
    // Create the app for real so it is not marked as "creating"; the mock delete's app id resolves normally.
    campaign.create(ctx.any.application({ applicationId: 777 }), Bytes('Test campaign'), Bytes('ipfs://test'), 1_000, 4_000_000_000)
    campaign.status.value = fields.status
    campaign.raised.value = fields.raised
    campaign.goal.value = fields.goal
    campaign.deadline.value = fields.deadline
    campaign.n.value = fields.n ?? 0
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
  function isRegistered(contract: Factory, app: Application): boolean {
    let result = false
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: ctx.defaultSender })]).execute(() => {
      result = toExternalValue(contract.isRegistered(app) as unknown as string) as unknown as boolean
    })
    return result
  }

  describe('create', () => {
    test('sets the deployer as owner and leaves the program hash and vault empty', () => {
      const factory = createFactory()
      expect(factory.owner.value).toEqual(ctx.defaultSender)
      expect(factory.approvalHash.value).toEqual(Bytes(''))
      expect(factory.vault.value).toEqual(0)
    })
  })

  describe('setApprovalHash', () => {
    test('stores the official program hash', () => {
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
        }).toThrow('only the owner can set the program hash')
      })
    })

    test('rejects a hash of the wrong length', () => {
      const factory = createFactory()
      expect(() => {
        factory.setApprovalHash(Bytes('too short'))
      }).toThrow('program hash must be 32 bytes')
    })
  })

  describe('setVault', () => {
    test('stores the official vault once', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      setVault(factory, vault)
      expect(factory.vault.value).toEqual(vault.id)
      expect(() => {
        factory.setVault(vault)
      }).toThrow('vault already set')
    })

    test('rejects a non-owner caller', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      const other = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: other })]).execute(() => {
        expect(() => {
          factory.setVault(vault)
        }).toThrow('only the owner can set the vault')
      })
    })

    test('rejects a vault bound to a different factory', () => {
      const factory = createFactory()
      const otherFactory = createFactory()
      const vault = vaultApp(otherFactory)
      expect(() => {
        factory.setVault(vault)
      }).toThrow('vault is not bound to this factory')
    })

    test('rejects a vault with no factory binding', () => {
      const factory = createFactory()
      expect(() => {
        factory.setVault(ctx.any.application({ applicationId: VAULT_APP_ID }))
      }).toThrow('vault is not bound to this factory')
    })
  })

  describe('register', () => {
    test('registers an official campaign bound to the official vault', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      setVault(factory, vault)
      const app = realCampaign(vault)
      setCampaignHash(factory, app)

      registerAs(factory, app)
      expect(factory.registered(app.id).value).toEqual(ctx.defaultSender)
    })

    test('rejects registration before the official hash is configured', () => {
      const factory = createFactory()
      const app = campaignApp()
      const factoryAddress = ctx.ledger.getApplicationForContract(factory).address
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          factory.register(app, ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: factoryAddress, amount: REGISTER_MBR }))
        }).toThrow('official program hash not configured')
      })
    })

    test('rejects registration before the official vault is configured', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      const app = realCampaign(vault)
      setCampaignHash(factory, app)

      expect(() => {
        registerAs(factory, app)
      }).toThrow('official vault not configured')
    })

    test('rejects a campaign pointing at a different vault', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      const otherVault = ctx.any.application({ applicationId: VAULT_APP_ID + 1 })
      setVault(factory, vault)
      const app = realCampaign(otherVault)
      setCampaignHash(factory, app)

      expect(() => {
        registerAs(factory, app)
      }).toThrow('campaign vault is not the official vault')
    })

    test('rejects a non-creator registering someone else’s campaign', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      setVault(factory, vault)
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
      const vault = vaultApp(factory)
      setVault(factory, vault)
      setHash(factory)
      const app = campaignApp(ctx.defaultSender, new Uint8Array([0x62, 0x61, 0x64]))

      expect(() => {
        registerAs(factory, app)
      }).toThrow('not an official kasakame campaign')
    })

    test('rejects a campaign with a custom clear-state program', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      setVault(factory, vault)
      setHash(factory)
      const app = campaignApp(ctx.defaultSender, FAKE_PROGRAM, new Uint8Array([0x62, 0x61, 0x64]))

      expect(() => {
        registerAs(factory, app)
      }).toThrow('not an official kasakame campaign')
    })

    test('rejects a different approval/clear split of the official bytes', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      setVault(factory, vault)
      const clear = new Uint8Array([0x0b, 0x81, 0x01, 0x43])
      setHash(factory, Bytes.fromBase64(programHash(FAKE_PROGRAM, clear)))
      // Same official byte sequence, but the first clear byte is moved into the approval program. The length prefix
      // binds the split, so this must not match the official hash.
      const splitApproval = new Uint8Array([...FAKE_PROGRAM, clear[0] ?? 0])
      const splitClear = clear.slice(1)
      const app = campaignApp(ctx.defaultSender, splitApproval, splitClear)

      expect(() => {
        registerAs(factory, app)
      }).toThrow('not an official kasakame campaign')
    })

    test('rejects a deposit below the registration minimum balance', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      setVault(factory, vault)
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
      const vault = vaultApp(factory)
      setVault(factory, vault)
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
      const vault = vaultApp(factory)
      setVault(factory, vault)
      setHash(factory)
      const app = campaignApp()

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          factory.register(app, ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: ctx.defaultSender, amount: REGISTER_MBR }))
        }).toThrow('payment must be made to the factory')
      })
    })

    test('rejects a registration payment that closes the sender account', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      setVault(factory, vault)
      setHash(factory)
      const app = campaignApp()
      const factoryAddress = ctx.ledger.getApplicationForContract(factory).address

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          factory.register(
            app,
            ctx.any.txn.payment({
              sender: ctx.defaultSender,
              receiver: factoryAddress,
              amount: REGISTER_MBR,
              closeRemainderTo: factoryAddress,
            }),
          )
        }).toThrow('payment must not close')
      })
    })

    test('rejects a registration payment that rekeys the sender', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      setVault(factory, vault)
      setHash(factory)
      const app = campaignApp()
      const factoryAddress = ctx.ledger.getApplicationForContract(factory).address

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          factory.register(
            app,
            ctx.any.txn.payment({
              sender: ctx.defaultSender,
              receiver: factoryAddress,
              amount: REGISTER_MBR,
              rekeyTo: ctx.any.account(),
            }),
          )
        }).toThrow('payment must not rekey')
      })
    })

    test('rejects double registration of the same campaign', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      setVault(factory, vault)
      const app = realCampaign(vault)
      setCampaignHash(factory, app)
      registerAs(factory, app)

      expect(() => {
        registerAs(factory, app)
      }).toThrow('campaign already registered')
    })

    test('rejects reusing one payment for a second registration in the same group', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      setVault(factory, vault)
      const appA = realCampaign(vault)
      const appB = realCampaign(vault)
      setCampaignHash(factory, appA)

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

      expect(factory.registered(appA.id).exists).toBe(false)
      expect(factory.registered(appB.id).exists).toBe(true)
    })
  })

  describe('unregister', () => {
    const DELETE_SELECTOR = Bytes.fromHex('24378d3c')

    /**
     * A mock `Campaign.delete()` call for the unregister pairing check.
     *
     * @param app The campaign app to delete.
     * @param sender The delete sender (the creator).
     * @returns The mock application call.
     */
    function deleteCall(app: Application, sender = ctx.defaultSender) {
      return ctx.any.txn.applicationCall({
        appId: app,
        sender,
        onCompletion: OnCompleteAction.DeleteApplication,
        appArgs: [DELETE_SELECTOR],
      })
    }

    /**
     * Run `unregister` in the required `[unregister, delete]` group.
     *
     * @param factory The Factory.
     * @param app The campaign app.
     */
    function unregisterWithDelete(factory: Factory, app: Application) {
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender }), deleteCall(app)], 0).execute(() => {
        factory.unregister(app)
      })
    }

    test('returns the deposit and removes the registration for a pristine campaign', () => {
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 0, raised: 0, goal: 1000, deadline: 0 })

      unregisterWithDelete(factory, app)

      expect(factory.registered(app.id).exists).toBe(false)
      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payout.receiver).toEqual(ctx.defaultSender)
      expect(payout.amount).toEqual(REGISTER_MBR)
    })

    test('allows an all-cancelled campaign before the deadline', () => {
      ctx.ledger.patchGlobalData({ latestTimestamp: 1_000 })
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 0, raised: 0, goal: 1000, deadline: 2_000, n: 2 })

      unregisterWithDelete(factory, app)
      expect(factory.registered(app.id).exists).toBe(false)
    })

    test('requires the delete pair even for an unregistered campaign', () => {
      const factory = createFactory()
      const app = campaignApp()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          factory.unregister(app)
        }).toThrow('delete must follow unregister')
      })
    })

    test('no-ops for an unregistered campaign in the cleanup group', () => {
      const factory = createFactory()
      const app = campaignApp()

      unregisterWithDelete(factory, app)
      expect(factory.registered(app.id).exists).toBe(false)
    })

    test('rejects a non-creator unregistering an unregistered campaign', () => {
      const factory = createFactory()
      const app = campaignApp()
      const other = ctx.any.account()

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: other })]).execute(() => {
        expect(() => {
          factory.unregister(app)
        }).toThrow('only the campaign creator can unregister')
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

      unregisterWithDelete(factory, app)
      expect(factory.registered(app.id).exists).toBe(false)
    })

    test('allows a failed campaign', () => {
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 1, raised: 100, goal: 1000, deadline: 2_000 })

      unregisterWithDelete(factory, app)
      expect(factory.registered(app.id).exists).toBe(false)
    })

    test('allows a claimed campaign', () => {
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 2, raised: 1000, goal: 1000, deadline: 2_000 })

      unregisterWithDelete(factory, app)
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

    test('rejects unregister without the delete in the same group', () => {
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 0, raised: 0, goal: 1000, deadline: 0 })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender })], 0).execute(() => {
        expect(() => {
          factory.unregister(app)
        }).toThrow('delete must follow unregister')
      })
    })

    test('rejects a delete for another app', () => {
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 0, raised: 0, goal: 1000, deadline: 0 })
      const other = ctx.any.application({ applicationId: FAKE_APP_ID })

      ctx.txn
        .createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender }), deleteCall(other)], 0)
        .execute(() => {
          expect(() => {
            factory.unregister(app)
          }).toThrow('delete must target the campaign')
        })
    })

    test('rejects a delete from someone other than the creator', () => {
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 0, raised: 0, goal: 1000, deadline: 0 })
      const other = ctx.any.account()

      ctx.txn
        .createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender }), deleteCall(app, other)], 0)
        .execute(() => {
          expect(() => {
            factory.unregister(app)
          }).toThrow('delete must come from the creator')
        })
    })

    test('rejects a non-DeleteApplication call', () => {
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 0, raised: 0, goal: 1000, deadline: 0 })
      const call = ctx.any.txn.applicationCall({ appId: app, sender: ctx.defaultSender, appArgs: [DELETE_SELECTOR] })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender }), call], 0).execute(() => {
        expect(() => {
          factory.unregister(app)
        }).toThrow('delete must be DeleteApplication')
      })
    })

    test('rejects a delete with the wrong arg count', () => {
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 0, raised: 0, goal: 1000, deadline: 0 })
      const call = ctx.any.txn.applicationCall({
        appId: app,
        sender: ctx.defaultSender,
        onCompletion: OnCompleteAction.DeleteApplication,
        appArgs: [],
      })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender }), call], 0).execute(() => {
        expect(() => {
          factory.unregister(app)
        }).toThrow('delete args mismatch')
      })
    })

    test('rejects a delete with the wrong selector', () => {
      const factory = createFactory()
      const app = registeredCampaign(factory, { status: 0, raised: 0, goal: 1000, deadline: 0 })
      const call = ctx.any.txn.applicationCall({
        appId: app,
        sender: ctx.defaultSender,
        onCompletion: OnCompleteAction.DeleteApplication,
        appArgs: [Bytes.fromHex('00000000')],
      })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: factory, sender: ctx.defaultSender }), call], 0).execute(() => {
        expect(() => {
          factory.unregister(app)
        }).toThrow('delete selector mismatch')
      })
    })
  })

  describe('isRegistered', () => {
    test('reflects registration state', () => {
      const factory = createFactory()
      const vault = vaultApp(factory)
      setVault(factory, vault)
      const app = realCampaign(vault)
      setCampaignHash(factory, app)

      expect(isRegistered(factory, app)).toBe(false)

      registerAs(factory, app)
      expect(isRegistered(factory, app)).toBe(true)
    })
  })
})
