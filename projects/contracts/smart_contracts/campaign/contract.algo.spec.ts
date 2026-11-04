import type { Account, Application, bytes } from '@algorandfoundation/algorand-typescript'
import { Bytes, OnCompleteAction } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext, toExternalValue } from '@algorandfoundation/algorand-typescript-testing'
import algosdk from 'algosdk'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { ClaimsVault } from '../claimsvault/contract.algo'
import { Campaign } from './contract.algo'

/**
 * Behavioral tests for the Campaign contract (claim-tree design), run against the offline AVM emulation.
 *
 * Every tree operation runs differentially: expected roots come from the Python reference oracle (`../oracle.py`),
 * driven with the mock payments' real `txnId`s. The vault inner calls (`payBack`/`payClaim`/`settle`/`notifyDelete`)
 * target the stub vault app and succeed as no-ops offline - their real routing and effects run on LocalNet in
 * `contract.integration.test.ts`.
 */

const GOAL = 10_000_000
const CREATION_TIME = 1_000
const DEADLINE = 2_000
const MAX_DURATION = 180 * 24 * 60 * 60
const TITLE = Bytes('My first novel')
const METADATA_URI = Bytes('ipfs://QmExample')
const VAULT_APP_ID = 777
const FACTORY_APP_ID = 7
const VAULT_CREDIT_SELECTOR = Bytes.fromHex('8027a4bb')
const FACTORY_UNREGISTER_SELECTOR = Bytes.fromHex('5df32277')
const ORACLE = path.resolve(__dirname, '../oracle.py')

describe('Campaign', () => {
  const ctx = new TestExecutionContext()
  let stateFile: string

  beforeEach(() => {
    ctx.reset()
    ctx.ledger.patchGlobalData({ latestTimestamp: CREATION_TIME })
    stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-spec-')), 'state.json')
    oracle('init')
  })

  function oracle(cmd: string, ...args: string[]): unknown {
    const out = execFileSync('python3', [ORACLE, stateFile, cmd, ...args], { encoding: 'utf8' })
    return JSON.parse(out) as unknown
  }

  /**
   * Hex of an account's 32-byte address.
   *
   * @param account The account.
   * @returns Lowercase hex.
   */
  function accountHex(account: Account): string {
    // Puya `bytes` is string-branded statically but Uint8Array at runtime (per the testing lib docs) - hence the bridge.
    return Buffer.from(toExternalValue(account.bytes as unknown as bytes)).toString('hex')
  }

  /** The vault app stub (inner calls to it succeed as no-ops offline; real routing runs on LocalNet). */
  function vaultApp() {
    return ctx.any.application({ applicationId: VAULT_APP_ID })
  }

  /** The vault's app account as an `Account` value for test transactions. */
  function vaultAccount() {
    return ctx.ledger.getAccount(Bytes(algosdk.decodeAddress(algosdk.getApplicationAddress(VAULT_APP_ID).toString()).publicKey))
  }

  function createCampaign(goal = GOAL, deadline = DEADLINE) {
    const contract = ctx.contract.create(Campaign)
    contract.create(vaultApp(), TITLE, METADATA_URI, goal, deadline)
    return contract
  }

  /**
   * A campaign bound to a real ClaimsVault with a Factory binding, for the delete group-shape check.
   *
   * @param factoryAppId The Factory app id the vault points at.
   * @returns The campaign, its Factory app, and the campaign app id.
   */
  function createCampaignWithFactory(factoryAppId = FACTORY_APP_ID) {
    const vault = ctx.contract.create(ClaimsVault)
    // The offline ledger keeps an Application-typed global as an ApplicationCls; the AVM stores the app id as uint64.
    ;(vault.factory as unknown as { value: unknown }).value = factoryAppId
    const contract = ctx.contract.create(Campaign)
    contract.create(ctx.ledger.getApplicationForContract(vault), TITLE, METADATA_URI, GOAL, DEADLINE)
    return {
      contract,
      factoryApp: ctx.any.application({ applicationId: factoryAppId }),
      campaignId: toExternalValue(ctx.ledger.getApplicationForContract(contract).id),
    }
  }

  function rootHex(contract: Campaign): string {
    return Buffer.from(toExternalValue(contract.root.value)).toString('hex')
  }

  /**
   * Big-endian uint64 bytes for ABI app args.
   *
   * @param value The value.
   * @returns Eight bytes.
   */
  function toU64(value: number | bigint): Uint8Array {
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64BE(BigInt(value))
    return new Uint8Array(buf)
  }

  /** Hex of the first inner app call's method selector (keeps the embedded vault selectors in sync). */
  function firstInnerSelector(): string {
    const call = ctx.txn.lastGroup.getItxnGroup(0).getApplicationCallInnerTxn()
    return Buffer.from(toExternalValue(call.appArgs(0))).toString('hex')
  }

  /**
   * The oracle path blob for position k (siblings ‖ top ‖ lower).
   *
   * @param k Leaf position.
   * @returns The concatenated blob.
   */
  function pathBlob(k: number): Buffer {
    const path = oracle('path', k.toString()) as { siblings: string[]; top: string | null; lower: string[] }
    return Buffer.concat([
      ...path.siblings.map((s) => Buffer.from(s, 'hex')),
      ...(path.top === null ? [] : [Buffer.from(path.top, 'hex')]),
      ...path.lower.map((s) => Buffer.from(s, 'hex')),
    ])
  }

  /**
   * Pledge `amount` as `backer`, asserting root/n/raised against the oracle at every step.
   *
   * @param contract The campaign to pledge to.
   * @param backer The non-creator backer.
   * @param amount Pledge amount in microAlgos.
   * @returns The pledge payment's TxID (hex), for later spend proofs.
   */
  function pledgeAs(contract: Campaign, backer: Account, amount: number): string {
    const front = oracle('frontier') as { peaks: string[] }
    const frontier = Buffer.concat(front.peaks.map((p) => Buffer.from(p, 'hex')))
    const campaignId = toExternalValue(ctx.ledger.getApplicationForContract(contract).id)
    let txid = ''
    ctx.txn
      .createScope(
        [
          ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
          ctx.any.txn.applicationCall({
            appId: contract.vault.value,
            sender: backer,
            appArgs: [VAULT_CREDIT_SELECTOR, toU64(campaignId), toU64(amount)],
          }),
        ],
        1,
      )
      .execute(() => {
        // Rebuild the payment handle inside the scope so the mock carries the scope's transaction.
        const pay = ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount })
        txid = Buffer.from(toExternalValue(pay.txnId)).toString('hex')
        contract.pledge(pay, Bytes(frontier))
      })
    const expected = oracle('append', accountHex(backer), amount.toString(), txid) as {
      n: number
      root: string
      raised: number
    }
    expect(contract.n.value).toEqual(expected.n)
    expect(rootHex(contract)).toEqual(expected.root)
    expect(contract.raised.value).toEqual(expected.raised)
    return txid
  }

  describe('create', () => {
    test('sets global state with an empty tree', () => {
      const contract = createCampaign()

      expect(contract.creator.value).toEqual(ctx.defaultSender)
      expect(contract.vault.value.id).toEqual(VAULT_APP_ID)
      expect(contract.title.value).toEqual(TITLE)
      expect(contract.metadataUri.value).toEqual(METADATA_URI)
      expect(contract.goal.value).toEqual(GOAL)
      expect(contract.deadline.value).toEqual(DEADLINE)
      expect(contract.raised.value).toEqual(0)
      expect(contract.status.value).toEqual(0)
      expect(rootHex(contract)).toEqual('00'.repeat(32))
      expect(contract.n.value).toEqual(0)
    })

    test('rejects a zero vault', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(ctx.any.application({ applicationId: 0 }), TITLE, METADATA_URI, GOAL, DEADLINE)
      }).toThrow('vault required')
    })

    test('rejects an empty title', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(vaultApp(), Bytes(''), METADATA_URI, GOAL, DEADLINE)
      }).toThrow('title must not be empty')
    })

    test('rejects an overlong title', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(vaultApp(), Bytes(Buffer.alloc(129)), METADATA_URI, GOAL, DEADLINE)
      }).toThrow('title too long')
    })

    test('rejects an overlong metadata uri', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(vaultApp(), TITLE, Bytes(Buffer.alloc(129)), GOAL, DEADLINE)
      }).toThrow('metadata uri too long')
    })

    test('rejects a goal of zero', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(vaultApp(), TITLE, METADATA_URI, 0, DEADLINE)
      }).toThrow('goal must be greater than zero')
    })

    test('rejects a deadline in the past', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(vaultApp(), TITLE, METADATA_URI, GOAL, CREATION_TIME)
      }).toThrow('deadline must be in the future')
    })

    test('accepts a deadline exactly at the maximum duration', () => {
      const contract = ctx.contract.create(Campaign)
      contract.create(vaultApp(), TITLE, METADATA_URI, GOAL, CREATION_TIME + MAX_DURATION)
      expect(contract.deadline.value).toEqual(CREATION_TIME + MAX_DURATION)
    })

    test('rejects a deadline beyond the maximum duration', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(vaultApp(), TITLE, METADATA_URI, GOAL, CREATION_TIME + MAX_DURATION + 1)
      }).toThrow('deadline too far')
    })
  })

  describe('pledge', () => {
    test('appends four pledges, root/n/raised matching the oracle at every step', () => {
      const contract = createCampaign()
      const backers = [ctx.any.account(), ctx.any.account(), ctx.any.account()]

      const backerA = backers[0] === undefined ? ctx.defaultSender : backers[0]
      const backerB = backers[1] === undefined ? ctx.defaultSender : backers[1]
      const backerC = backers[2] === undefined ? ctx.defaultSender : backers[2]
      pledgeAs(contract, backerA, 3_000_000)
      pledgeAs(contract, backerB, 1_000_000)
      pledgeAs(contract, backerA, 2_000_000)
      pledgeAs(contract, backerC, 1_000_000)

      expect(contract.n.value).toEqual(4)
      expect(contract.raised.value).toEqual(7_000_000)
    })

    test('rejects reusing one payment for a second pledge', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      const campaignId = toExternalValue(ctx.ledger.getApplicationForContract(contract).id)
      const pay = ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 })
      const group = [
        pay,
        ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ctx.any.txn.applicationCall({
          appId: contract.vault.value,
          sender: backer,
          appArgs: [VAULT_CREDIT_SELECTOR, toU64(campaignId), toU64(100)],
        }),
        ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
      ]
      ctx.txn.createScope(group, 1).execute(() => {
        contract.pledge(pay, Bytes(new Uint8Array()))
      })
      const frontier = contract.root.value
      ctx.txn.createScope(group, 3).execute(() => {
        expect(() => {
          contract.pledge(pay, frontier)
        }).toThrow('payment must immediately precede pledge')
      })

      expect(contract.n.value).toEqual(1)
      expect(contract.raised.value).toEqual(100)
    })

    test('rejects a pledge without a matching vault credit', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      const campaignId = toExternalValue(ctx.ledger.getApplicationForContract(contract).id)
      const pay = ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 })
      const pledgeCall = ctx.any.txn.applicationCall({ appId: contract, sender: backer })
      const other = ctx.any.account()
      const otherApp = ctx.any.application({ applicationId: 999 })
      const credit = (overrides: { appId?: Application; sender?: Account; appArgs?: unknown[]; onCompletion?: OnCompleteAction } = {}) =>
        ctx.any.txn.applicationCall({
          appId: overrides.appId ?? contract.vault.value,
          sender: overrides.sender ?? backer,
          appArgs: overrides.appArgs ?? [VAULT_CREDIT_SELECTOR, toU64(campaignId), toU64(100)],
          onCompletion: overrides.onCompletion ?? OnCompleteAction.NoOp,
        })

      const cases: { group: unknown[]; expected: string }[] = [
        { group: [pay, pledgeCall], expected: 'credit must follow pledge' },
        {
          group: [pay, pledgeCall, ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 })],
          expected: 'credit must follow pledge',
        },
        { group: [pay, pledgeCall, credit({ appId: otherApp })], expected: 'credit must call the vault' },
        { group: [pay, pledgeCall, credit({ sender: other })], expected: 'credit must come from the pledger' },
        { group: [pay, pledgeCall, credit({ onCompletion: OnCompleteAction.ClearState })], expected: 'credit must be a NoOp call' },
        {
          group: [pay, pledgeCall, credit({ appArgs: [VAULT_CREDIT_SELECTOR, toU64(campaignId)] })],
          expected: 'credit args mismatch',
        },
        {
          group: [pay, pledgeCall, credit({ appArgs: [Bytes.fromHex('00000000'), toU64(campaignId), toU64(100)] })],
          expected: 'credit selector mismatch',
        },
        {
          group: [pay, pledgeCall, credit({ appArgs: [VAULT_CREDIT_SELECTOR, toU64(campaignId + 1n), toU64(100)] })],
          expected: 'credit app mismatch',
        },
        {
          group: [pay, pledgeCall, credit({ appArgs: [VAULT_CREDIT_SELECTOR, toU64(campaignId), toU64(101)] })],
          expected: 'credit amount mismatch',
        },
      ]

      for (const { group, expected } of cases) {
        ctx.txn.createScope(group as never[], 1).execute(() => {
          expect(() => {
            contract.pledge(pay, Bytes(new Uint8Array()))
          }).toThrow(expected)
        })
      }
      expect(contract.n.value).toEqual(0)
      expect(contract.raised.value).toEqual(0)
    })

    test('rejects pledging after the deadline', () => {
      const contract = createCampaign()
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      const backer = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }), Bytes(new Uint8Array()))
          }).toThrow('pledging is closed')
        })
    })

    test('rejects a failed campaign', () => {
      const contract = createCampaign()
      contract.status.value = 1
      const backer = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }), Bytes(new Uint8Array()))
          }).toThrow('campaign is not open')
        })
    })

    test('rejects a payment to the wrong receiver', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      const other = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: other, amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: other, amount: 100 }), Bytes(new Uint8Array()))
          }).toThrow('payment must be made to the vault')
        })
    })

    test('rejects a payment from someone other than the caller', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      const other = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: other, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: other, receiver: vaultAccount(), amount: 100 }), Bytes(new Uint8Array()))
          }).toThrow('payment must come from the caller')
        })
    })

    test('rejects a payment that closes the sender account', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100, closeRemainderTo: vaultAccount() }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(
              ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100, closeRemainderTo: vaultAccount() }),
              Bytes(new Uint8Array()),
            )
          }).toThrow('payment must not close')
        })
    })

    test('rejects a payment that rekeys the sender', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100, rekeyTo: ctx.any.account() }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(
              ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100, rekeyTo: ctx.any.account() }),
              Bytes(new Uint8Array()),
            )
          }).toThrow('payment must not rekey')
        })
    })

    test('rejects a zero pledge', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 0 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 0 }), Bytes(new Uint8Array()))
          }).toThrow('pledge must be greater than zero')
        })
    })

    test('rejects a creator self-pledge', () => {
      const contract = createCampaign()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: ctx.defaultSender }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(
              ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: vaultAccount(), amount: 100 }),
              Bytes(new Uint8Array()),
            )
          }).toThrow('creator cannot pledge to their own campaign')
        })
    })

    test('rejects a frontier of the wrong length', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      pledgeAs(contract, backer, 100)
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }), Bytes(new Uint8Array()))
          }).toThrow('bad frontier length')
        })
    })

    test('rejects a forged frontier', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      pledgeAs(contract, backer, 100)
      const front = oracle('frontier') as { peaks: string[] }
      const forged = Buffer.concat(front.peaks.map((p) => Buffer.from(p, 'hex')))
      forged[0] = forged[0] === 0 ? 1 : 0
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }), Bytes(forged))
          }).toThrow('stale or forged frontier')
        })
      // State untouched by the failed append.
      const state = oracle('state') as { n: number; root: string; raised: number }
      expect(contract.n.value).toEqual(state.n)
      expect(rootHex(contract)).toEqual(state.root)
    })

    test('rejects a stale frontier after another pledge lands', () => {
      const contract = createCampaign()
      const backerA = ctx.any.account()
      const backerB = ctx.any.account()
      pledgeAs(contract, backerA, 100)
      const front = oracle('frontier') as { peaks: string[] }
      const stale = Buffer.concat(front.peaks.map((p) => Buffer.from(p, 'hex')))
      pledgeAs(contract, backerB, 100)
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backerA, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backerA }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backerA, receiver: vaultAccount(), amount: 100 }), Bytes(stale))
          }).toThrow('stale or forged frontier')
        })
    })
  })

  describe('cancelPledge', () => {
    test('rejects cancellation after the deadline', () => {
      const contract = createCampaign()
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.cancelPledge(0, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
      }).toThrow('pledging is closed')
    })

    test('rejects cancellation on a non-open campaign', () => {
      const contract = createCampaign()
      contract.status.value = 1
      expect(() => {
        contract.cancelPledge(0, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
      }).toThrow('campaign is not open')
    })

    test('cancels a pledge differentially and rejects its double-spend', () => {
      const contract = createCampaign()
      const backerA = ctx.any.account()
      const backerB = ctx.any.account()
      const txidA = pledgeAs(contract, backerA, 1_000_000)
      pledgeAs(contract, backerB, 2_000_000)

      spendAs(contract, backerA, 0, 1_000_000, txidA, 'cancelPledge')
      expect(contract.raised.value).toEqual(2_000_000)
      expect(firstInnerSelector()).toEqual('b0e0eedf')

      // The same proof no longer verifies: the leaf holds Z now.
      const blob = pathBlob(0)
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backerA })]).execute(() => {
        expect(() => {
          contract.cancelPledge(0, 1_000_000, Bytes(Buffer.from(txidA, 'hex')), Bytes(blob))
        }).toThrow('proof does not match root')
      })
      expect(contract.raised.value).toEqual(2_000_000)
    })

    test('rejects spends with malformed inputs', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      const txid = pledgeAs(contract, backer, 1_000_000)
      const blob = pathBlob(0)
      const scope = () => ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backer })])

      scope().execute(() => {
        expect(() => {
          contract.cancelPledge(0, 0, Bytes(Buffer.from(txid, 'hex')), Bytes(blob))
        }).toThrow('amount must be greater than zero')
      })
      scope().execute(() => {
        expect(() => {
          contract.cancelPledge(0, 1_000_000, Bytes(Buffer.alloc(16)), Bytes(blob))
        }).toThrow('bad txid length')
      })
      scope().execute(() => {
        expect(() => {
          contract.cancelPledge(7, 1_000_000, Bytes(Buffer.from(txid, 'hex')), Bytes(blob))
        }).toThrow('unknown position')
      })
      scope().execute(() => {
        expect(() => {
          contract.cancelPledge(0, 1_000_000, Bytes(Buffer.from(txid, 'hex')), Bytes(Buffer.alloc(31)))
        }).toThrow('bad path length')
      })
    })
  })

  describe('refund', () => {
    test('rejects a refund before the deadline', () => {
      const contract = createCampaign()
      expect(() => {
        contract.refund(0, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
      }).toThrow('deadline has not passed')
    })

    test('rejects a refund when the goal was reached', () => {
      const contract = createCampaign(100, DEADLINE)
      contract.raised.value = 100
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.refund(0, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
      }).toThrow('goal was reached, no refunds')
    })

    test('rejects a refund on a claimed campaign', () => {
      const contract = createCampaign()
      contract.status.value = 2
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.refund(0, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
      }).toThrow('campaign is not refundable')
    })

    test('refunds non-sequentially after the deadline, flipping to failed once', () => {
      const contract = createCampaign()
      const backerA = ctx.any.account()
      const backerB = ctx.any.account()
      const txidA1 = pledgeAs(contract, backerA, 1_000_000)
      const txidB = pledgeAs(contract, backerB, 2_000_000)
      const txidA2 = pledgeAs(contract, backerA, 1_000_000)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      // k=2: r=0 with a higher peak (exercises hasTop); k=1,0: r=1, c=1. The oracle advances after every null.
      spendAs(contract, backerA, 2, 1_000_000, txidA2, 'refund')
      expect(contract.status.value).toEqual(1)
      spendAs(contract, backerB, 1, 2_000_000, txidB, 'refund')
      spendAs(contract, backerA, 0, 1_000_000, txidA1, 'refund')
      expect(contract.raised.value).toEqual(0)
      expect(contract.n.value).toEqual(3)
    })
  })

  describe('claim', () => {
    test('rejects a non-creator caller', () => {
      const contract = createCampaign()
      const other = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: other })]).execute(() => {
        expect(() => {
          contract.claim()
        }).toThrow('only the creator can claim')
      })
    })

    test('rejects a claim before the deadline', () => {
      const contract = createCampaign()
      expect(() => {
        contract.claim()
      }).toThrow('deadline has not passed')
    })

    test('rejects a claim below the goal', () => {
      const contract = createCampaign()
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.claim()
      }).toThrow('goal not reached')
    })

    test('rejects a second claim', () => {
      const contract = createCampaign(100, DEADLINE)
      contract.raised.value = 100
      contract.status.value = 2
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.claim()
      }).toThrow('already claimed')
    })

    test('claims a funded campaign end to end', () => {
      const contract = createCampaign(2_000_000, DEADLINE)
      const backer = ctx.any.account()
      pledgeAs(contract, backer, 1_000_000)
      pledgeAs(contract, backer, 1_000_000)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      contract.claim()

      expect(contract.status.value).toEqual(2)
      expect(firstInnerSelector()).toEqual('f8c4e0cb')
    })
  })

  describe('delete', () => {
    function deleteScope(contract: Campaign, sender: Account) {
      return ctx.txn.createScope([
        ctx.any.txn.applicationCall({ appId: contract, sender, onCompletion: OnCompleteAction.DeleteApplication }),
      ])
    }

    /**
     * The required `[Factory.unregister, Campaign.delete]` group for a Factory-bound vault.
     *
     * @param contract The campaign.
     * @param factoryApp The Factory app the vault points at.
     * @param sender The creator.
     * @returns The two group transactions.
     */
    function deleteGroup(contract: Campaign, factoryApp: ReturnType<typeof ctx.any.application>, sender = ctx.defaultSender) {
      const campaignId = toExternalValue(ctx.ledger.getApplicationForContract(contract).id)
      return [
        ctx.any.txn.applicationCall({ appId: factoryApp, sender, appArgs: [FACTORY_UNREGISTER_SELECTOR, toU64(campaignId)] }),
        ctx.any.txn.applicationCall({ appId: contract, sender, onCompletion: OnCompleteAction.DeleteApplication }),
      ]
    }

    test('requires the Factory unregister immediately before delete', () => {
      const { contract, factoryApp } = createCampaignWithFactory()
      ctx.txn.createScope(deleteGroup(contract, factoryApp), 1).execute(() => {
        contract.delete()
      })

      expect(firstInnerSelector()).toEqual('09200848')
    })

    test('rejects a raw delete when the vault has a Factory binding', () => {
      const { contract } = createCampaignWithFactory()
      deleteScope(contract, ctx.defaultSender).execute(() => {
        expect(() => {
          contract.delete()
        }).toThrow('unregister must precede delete')
      })
    })

    test('rejects an unregister for another campaign', () => {
      const { contract, factoryApp } = createCampaignWithFactory()
      const wrong = ctx.any.txn.applicationCall({
        appId: factoryApp,
        sender: ctx.defaultSender,
        appArgs: [FACTORY_UNREGISTER_SELECTOR, toU64(999_999)],
      })
      ctx.txn
        .createScope(
          [
            wrong,
            ctx.any.txn.applicationCall({ appId: contract, sender: ctx.defaultSender, onCompletion: OnCompleteAction.DeleteApplication }),
          ],
          1,
        )
        .execute(() => {
          expect(() => {
            contract.delete()
          }).toThrow('unregister app mismatch')
        })
    })

    test('rejects a ClearState unregister before delete', () => {
      const { contract, factoryApp } = createCampaignWithFactory()
      const campaignId = toExternalValue(ctx.ledger.getApplicationForContract(contract).id)
      const wrong = ctx.any.txn.applicationCall({
        appId: factoryApp,
        sender: ctx.defaultSender,
        onCompletion: OnCompleteAction.ClearState,
        appArgs: [FACTORY_UNREGISTER_SELECTOR, toU64(campaignId)],
      })
      ctx.txn
        .createScope(
          [
            wrong,
            ctx.any.txn.applicationCall({ appId: contract, sender: ctx.defaultSender, onCompletion: OnCompleteAction.DeleteApplication }),
          ],
          1,
        )
        .execute(() => {
          expect(() => {
            contract.delete()
          }).toThrow('unregister must be a NoOp call')
        })
    })

    test('rejects a non-creator caller', () => {
      const contract = createCampaign()
      const other = ctx.any.account()
      deleteScope(contract, other).execute(() => {
        expect(() => {
          contract.delete()
        }).toThrow('only the creator can delete')
      })
    })

    test('rejects deleting a campaign with live pledges', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      pledgeAs(contract, backer, 1_000_000)
      deleteScope(contract, ctx.defaultSender).execute(() => {
        expect(() => {
          contract.delete()
        }).toThrow('cannot delete a campaign with live pledges')
      })
    })

    test('deletes a pristine campaign, settling (a no-op with no box)', () => {
      const contract = createCampaign()
      deleteScope(contract, ctx.defaultSender).execute(() => {
        contract.delete()
      })

      // Settle runs unconditionally for non-claimed campaigns (a no-op here); then the escrow closes.
      expect(firstInnerSelector()).toEqual('09200848')
      const inner = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(inner.receiver).toEqual(ctx.defaultSender)
    })

    test('notifies the vault on a claimed campaign', () => {
      const contract = createCampaign(100, DEADLINE)
      contract.raised.value = 100
      contract.status.value = 2
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      deleteScope(contract, ctx.defaultSender).execute(() => {
        contract.delete()
      })

      expect(firstInnerSelector()).toEqual('87060e1d')
    })

    test('settles the vault on a failed campaign', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      pledgeAs(contract, backer, 1_000_000)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      deleteScope(contract, ctx.defaultSender).execute(() => {
        contract.delete()
      })

      expect(contract.status.value).toEqual(1)
      expect(firstInnerSelector()).toEqual('09200848')
    })

    test('settles the vault on an open campaign with everything cancelled', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      const txid = pledgeAs(contract, backer, 1_000_000)
      spendAs(contract, backer, 0, 1_000_000, txid, 'cancelPledge')
      deleteScope(contract, ctx.defaultSender).execute(() => {
        contract.delete()
      })

      expect(firstInnerSelector()).toEqual('09200848')
    })
  })

  /**
   * Spend a leaf via `cancelPledge`/`refund`, asserting root/n/raised against the oracle at every step.
   *
   * @param contract The campaign to spend from.
   * @param backer The leaf owner (rebuilt leaf binds the caller).
   * @param k Leaf position.
   * @param amount Pledged amount committed by the leaf.
   * @param txid Pledge payment TxID (hex).
   * @param method Which spend entry point to exercise.
   */
  function spendAs(contract: Campaign, backer: Account, k: number, amount: number, txid: string, method: 'cancelPledge' | 'refund'): void {
    const blob = pathBlob(k)
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backer })]).execute(() => {
      if (method === 'cancelPledge') {
        contract.cancelPledge(k, amount, Bytes(Buffer.from(txid, 'hex')), Bytes(blob))
      } else {
        contract.refund(k, amount, Bytes(Buffer.from(txid, 'hex')), Bytes(blob))
      }
    })
    const expected = oracle('null', k.toString(), amount.toString()) as { n: number; root: string; raised: number }
    expect(contract.n.value).toEqual(expected.n)
    expect(rootHex(contract)).toEqual(expected.root)
    expect(contract.raised.value).toEqual(expected.raised)
  }
})
