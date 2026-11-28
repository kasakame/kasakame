import {
  MAX_CAMPAIGN_DURATION_SECONDS,
  MAX_GOAL_MICRO_ALGOS,
  MAX_METADATA_URI_BYTES,
  MAX_PLEDGE_MICRO_ALGOS,
  MAX_TITLE_BYTES,
  MIN_CAMPAIGN_DURATION_SECONDS,
  MIN_GOAL_MICRO_ALGOS,
  MIN_PLEDGE_MICRO_ALGOS,
  VAULT_BOX_STATUS_FAILED_HEX,
} from '@kasakame/constants'
import { programHash } from '@kasakame/utils'
import type { TransactionSigner } from 'algosdk'
import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClaimTree from '../claim-tree/index.js'
import { MAX_TREE_SIZE } from '../claim-tree/index.js'
import { SPECS_VERSION } from '../index.js'
import {
  cancelPledge,
  claim,
  createCampaign,
  deleteCampaign,
  fetchVaultBox,
  fetchVaultConfig,
  finalize,
  isStaleProofError,
  pledge,
  pledgeGroup,
  refund,
  refundGroup,
  refundWindowEndsAt,
  registerCampaign,
  releaseClaimed,
  SdkError,
  settleOpen,
  vaultAddress,
  verifyDeployment,
} from './index.js'

const {
  sendCreateMock,
  sendRegisterMock,
  sendUnregisterMock,
  sendClaimMock,
  sendCancelPledgeMock,
  sendDeleteMock,
  sendFinalizeMock,
  sendReleaseClaimedMock,
  sendSettleOpenMock,
  paramsPledgeMock,
  paramsCreditMock,
  paramsCampaignRefundMock,
  paramsVaultRefundMock,
  paramsUnregisterMock,
  paymentMock,
  composerAddMock,
  composerBuildMock,
  composerSendMock,
  setSignerMock,
  campaignBoxValueMock,
  refundWindowMock,
  sweepTargetMock,
  waitForIndexerRoundMock,
  waitForIndexerCatchUpMock,
  fetchChainTimestampMock,
  loadTreeMock,
  clearTreeCacheMock,
  frontierMock,
  pathBlobMock,
  registryAppIdMock,
  getSuggestedParamsMock,
  campaignProgramHashMock,
} = vi.hoisted(() => ({
  sendCreateMock: vi.fn(),
  sendRegisterMock: vi.fn(),
  sendUnregisterMock: vi.fn(),
  sendClaimMock: vi.fn(),
  sendCancelPledgeMock: vi.fn(),
  sendDeleteMock: vi.fn(),
  sendFinalizeMock: vi.fn(),
  sendReleaseClaimedMock: vi.fn(),
  sendSettleOpenMock: vi.fn(),
  paramsPledgeMock: vi.fn(),
  paramsCreditMock: vi.fn(),
  paramsCampaignRefundMock: vi.fn(),
  paramsVaultRefundMock: vi.fn(),
  paramsUnregisterMock: vi.fn(),
  paymentMock: vi.fn(),
  composerAddMock: vi.fn(),
  composerBuildMock: vi.fn(),
  composerSendMock: vi.fn(),
  setSignerMock: vi.fn(),
  campaignBoxValueMock: vi.fn(),
  refundWindowMock: vi.fn(),
  sweepTargetMock: vi.fn(),
  waitForIndexerRoundMock: vi.fn(),
  waitForIndexerCatchUpMock: vi.fn(),
  fetchChainTimestampMock: vi.fn(),
  loadTreeMock: vi.fn(),
  clearTreeCacheMock: vi.fn(),
  frontierMock: vi.fn(),
  pathBlobMock: vi.fn(),
  registryAppIdMock: vi.fn(),
  getSuggestedParamsMock: vi.fn(),
  campaignProgramHashMock: vi.fn(),
}))

const appSpecMock: { name: string; byteCode?: { approval: string; clear: string } } = vi.hoisted(() => ({
  name: 'Campaign',
  byteCode: { approval: 'AA==', clear: 'AQ==' },
}))

const loggerMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock('../runtime/log.js', () => ({ sdkLogger: () => loggerMock }))

vi.mock('../generated/CampaignClient.js', () => ({
  APP_SPEC: appSpecMock,
  CampaignClient: class {
    appAddress = 'ESCROWADDRESS'
    params = {
      pledge: (...args: unknown[]) => paramsPledgeMock(...args),
      cancelPledge: (...args: unknown[]) => paramsPledgeMock(...args),
      refund: (...args: unknown[]) => paramsCampaignRefundMock(...args),
      claim: (...args: unknown[]) => paramsPledgeMock(...args),
      delete: { delete: (...args: unknown[]) => paramsPledgeMock(...args) },
    }
    send = {
      claim: sendClaimMock,
      cancelPledge: sendCancelPledgeMock,
      delete: { delete: sendDeleteMock },
    }
  },
  CampaignFactory: class {
    send = { create: { create: sendCreateMock } }
  },
}))

vi.mock('../generated/ClaimsVaultClient.js', () => ({
  ClaimsVaultClient: class {
    appAddress = 'VAULTADDRESS'
    params = {
      credit: (...args: unknown[]) => paramsCreditMock(...args),
      refund: (...args: unknown[]) => paramsVaultRefundMock(...args),
    }
    send = {
      settleOpen: sendSettleOpenMock,
      finalize: sendFinalizeMock,
      releaseClaimed: sendReleaseClaimedMock,
    }
    state = {
      box: { campaignBox: { value: (...args: unknown[]) => campaignBoxValueMock(...args) } },
      global: {
        refundWindow: (...args: unknown[]) => refundWindowMock(...args),
        sweepTarget: (...args: unknown[]) => sweepTargetMock(...args),
      },
    }
  },
}))

vi.mock('../generated/RegistryClient.js', () => ({
  RegistryClient: class {
    appAddress = 'REGISTRYADDRESS'
    params = {
      unregister: (...args: unknown[]) => paramsUnregisterMock(...args),
    }
    send = {
      register: sendRegisterMock,
      unregister: sendUnregisterMock,
    }
    state = {
      global: {
        campaignProgramHash: () =>
          Promise.resolve(campaignProgramHashMock()).then((value: Uint8Array | undefined) => ({
            asByteArray: () => value,
          })),
      },
    }
  },
}))

vi.mock('../runtime/config.js', () => ({
  getSdkConfig: () => ({
    algorand: {
      createTransaction: { payment: paymentMock },
      getSuggestedParams: (...args: unknown[]) => getSuggestedParamsMock(...args),
      send: {
        newGroup: () => ({
          addAppCallMethodCall: (...args: unknown[]) => composerAddMock(...args),
          build: composerBuildMock,
          send: composerSendMock,
        }),
      },
      account: { setSigner: (...args: unknown[]) => setSignerMock(...args) },
    },
    registryAppId: registryAppIdMock(),
    vaultAppId: 2002n,
  }),
}))
vi.mock('../runtime/indexer.js', () => ({
  waitForIndexerRound: (...args: unknown[]) => waitForIndexerRoundMock(...args),
  waitForIndexerCatchUp: (...args: unknown[]) => waitForIndexerCatchUpMock(...args),
  waitForIndexerCatchUpBestEffort: async (...args: unknown[]) => {
    try {
      await waitForIndexerCatchUpMock(...args)
    } catch {
      // The write is confirmed; the next read retries.
    }
  },
}))
vi.mock('../runtime/clock.js', () => ({
  fetchChainTimestamp: (...args: unknown[]) => fetchChainTimestampMock(...args),
}))

vi.mock('../claim-tree/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaimTree>()
  return {
    ...actual,
    clearTreeCache: (...args: unknown[]) => clearTreeCacheMock(...args),
    loadTree: (...args: unknown[]) => loadTreeMock(...args),
    frontierForPledge: (...args: unknown[]) => frontierMock(...args),
    pathBlobForRefund: (...args: unknown[]) => pathBlobMock(...args),
  }
})

const session = {
  address: 'ADDRESS',
  signer: (() => new Uint8Array()) as unknown as TransactionSigner,
}

// The real app-account address of the configured vault (app id 2002).
const VAULT_APP_ADDRESS = algosdk.getApplicationAddress(2002n).toString()

/**
 * A packed vault box with the given inflow/outflow totals.
 *
 * @param paidIn Total inflows in microAlgos.
 * @param paidOut Total outflows in microAlgos.
 * @param status Vault box status byte (1 Open, 2 Failed, 3 Claimed).
 * @returns The 65-byte vault box.
 */
function vaultBox(paidIn: bigint, paidOut: bigint, status = 0): Uint8Array {
  const box = new Uint8Array(65)
  const view = new DataView(box.buffer)
  view.setBigUint64(0, paidIn)
  view.setBigUint64(8, paidOut)
  box[56] = status
  return box
}

describe('transaction helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    waitForIndexerRoundMock.mockResolvedValue(undefined)
    waitForIndexerCatchUpMock.mockResolvedValue(undefined)
    fetchChainTimestampMock.mockResolvedValue(0n)
    loadTreeMock.mockResolvedValue({ leaves: Array.from({ length: 4 }, () => new Uint8Array(32)), raised: 0n })
    frontierMock.mockReturnValue(new Uint8Array())
    pathBlobMock.mockReturnValue(new Uint8Array())
    registryAppIdMock.mockReturnValue(1001n)
    campaignProgramHashMock.mockReturnValue(programHash(new Uint8Array([0]), new Uint8Array([1])))
    appSpecMock.byteCode = { approval: 'AA==', clear: 'AQ==' }
    getSuggestedParamsMock.mockResolvedValue({ minFee: 1_000n })
    campaignBoxValueMock.mockResolvedValue(new Uint8Array(65))
    paramsPledgeMock.mockResolvedValue({ pledge: 'params' })
    paramsCreditMock.mockResolvedValue({ credit: 'params' })
    paramsCampaignRefundMock.mockResolvedValue({ refund: 'params' })
    paramsVaultRefundMock.mockResolvedValue({ refund: 'params' })
    paramsUnregisterMock.mockResolvedValue({ unregister: 'params' })
    paymentMock.mockResolvedValue({ payment: 'pay-txn' })
    composerBuildMock.mockResolvedValue({ transactions: [{ txn: { group: new Uint8Array(32) }, signer: 'signer' }] })
    composerSendMock.mockResolvedValue({ confirmations: [{ confirmedRound: 99n }], txIds: ['GROUP'] })
    sendCreateMock.mockResolvedValue({
      result: { appId: 9n, appAddress: { toString: () => 'ESCROW' }, txIds: ['CREATE'], confirmation: { confirmedRound: 99n } },
    })
    for (const mock of [
      sendRegisterMock,
      sendUnregisterMock,
      sendClaimMock,
      sendCancelPledgeMock,
      sendDeleteMock,
      sendSettleOpenMock,
      sendFinalizeMock,
      sendReleaseClaimedMock,
    ]) {
      mock.mockResolvedValue({ confirmation: { confirmedRound: 99n }, txIds: ['CLIENT'] })
    }
  })

  it('vaultAddress derives from the configured vault app id', () => {
    expect(vaultAddress()).toBe(VAULT_APP_ADDRESS)
  })

  it('createCampaign runs create then register (nothing funded)', async () => {
    const result = await createCampaign(session, 'Title', 'ipfs://meta', 1_000_000n, BigInt(MIN_CAMPAIGN_DURATION_SECONDS))
    expect(result).toEqual({
      txIds: ['CREATE'],
      confirmedRound: 99n,
      appId: 9n,
      appAddress: 'ESCROW',
      registered: true,
      registerTxIds: ['CLIENT'],
    })
    expect(sendCreateMock).toHaveBeenCalledOnce()
    expect(sendRegisterMock).toHaveBeenCalledOnce()
    expect(waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
    expect(loggerMock.info).toHaveBeenCalledWith('write.confirmed', {
      operation: 'createCampaign',
      appId: '9',
      txIds: ['CREATE'],
      confirmedRound: '99',
    })
  })

  it('createCampaign returns the app id when the post-send indexer wait fails', async () => {
    waitForIndexerCatchUpMock.mockRejectedValueOnce(new Error('indexer unreachable'))

    const result = await createCampaign(session, 'Title', 'ipfs://meta', 1_000_000n, BigInt(MIN_CAMPAIGN_DURATION_SECONDS))

    expect(result).toEqual({
      txIds: ['CREATE'],
      confirmedRound: 99n,
      appId: 9n,
      appAddress: 'ESCROW',
      registered: true,
      registerTxIds: ['CLIENT'],
    })
    expect(waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
  })

  it('returns the app id when registration fails', async () => {
    sendRegisterMock.mockRejectedValueOnce(new Error('not an official kasakame campaign'))

    const result = await createCampaign(session, 'Title', 'ipfs://meta', 1_000_000n, BigInt(MIN_CAMPAIGN_DURATION_SECONDS))

    expect(result).toEqual({
      txIds: ['CREATE'],
      confirmedRound: 99n,
      appId: 9n,
      appAddress: 'ESCROW',
      registered: false,
      registerError: 'not an official kasakame campaign',
    })
    expect(loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'registerCampaign',
      appId: '9',
      type: 'chain-state',
      code: 'not-an-official-kasakame-campaign',
    })
    expect(waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
  })

  it('treats an already-registered race during create as registered', async () => {
    sendRegisterMock.mockRejectedValueOnce(new Error('campaign already registered'))

    const result = await createCampaign(session, 'Title', 'ipfs://meta', 1_000_000n, BigInt(MIN_CAMPAIGN_DURATION_SECONDS))

    expect(result).toMatchObject({ registered: true })
    expect(result.registerError).toBeUndefined()
    expect(loggerMock.debug).toHaveBeenCalledWith('register.already-registered', { appId: '9' })
    expect(loggerMock.warn).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error registration failure', async () => {
    sendRegisterMock.mockRejectedValueOnce('not an official kasakame campaign')

    const result = await createCampaign(session, 'Title', 'ipfs://meta', 1_000_000n, BigInt(MIN_CAMPAIGN_DURATION_SECONDS))

    expect(result.registered).toBe(false)
    expect(result.registerError).toBe('not an official kasakame campaign')
  })

  it('registerCampaign retries registration and tolerates an already-registered campaign', async () => {
    await registerCampaign(9n, session)
    expect(sendRegisterMock).toHaveBeenCalledOnce()
    expect(waitForIndexerCatchUpMock).toHaveBeenCalledOnce()

    sendRegisterMock.mockRejectedValueOnce(new Error('campaign already registered'))
    await expect(registerCampaign(9n, session)).resolves.toEqual({ txIds: [] })
    expect(sendRegisterMock).toHaveBeenCalledTimes(2)
    expect(loggerMock.debug).toHaveBeenCalledWith('register.already-registered', { appId: '9' })
    expect(loggerMock.warn).not.toHaveBeenCalled()
  })

  it('registerCampaign surfaces other registration failures', async () => {
    sendRegisterMock.mockRejectedValueOnce(new Error('not an official kasakame campaign'))

    await expect(registerCampaign(9n, session)).rejects.toThrow('not an official kasakame campaign')
    expect(waitForIndexerCatchUpMock).not.toHaveBeenCalled()
    expect(loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'registerCampaign',
      appId: '9',
      type: 'chain-state',
      code: 'not-an-official-kasakame-campaign',
    })
  })

  it('registerCampaign is a no-op when no registry is configured', async () => {
    registryAppIdMock.mockReturnValue(0n)

    await registerCampaign(9n, session)

    expect(sendRegisterMock).not.toHaveBeenCalled()
    expect(waitForIndexerCatchUpMock).not.toHaveBeenCalled()
    expect(loggerMock.info).not.toHaveBeenCalled()
  })

  it('a campaign whose registration failed can still be deleted', async () => {
    sendRegisterMock.mockRejectedValueOnce(new Error('not an official kasakame campaign'))
    const result = await createCampaign(session, 'Title', 'ipfs://meta', 1_000_000n, BigInt(MIN_CAMPAIGN_DURATION_SECONDS))

    await deleteCampaign(result.appId, session)

    expect(paramsUnregisterMock).toHaveBeenCalledOnce()
    expect(composerAddMock).toHaveBeenCalledTimes(2)
    expect(composerSendMock).toHaveBeenCalledOnce()
  })

  it('creates without registering when no registry is configured', async () => {
    registryAppIdMock.mockReturnValue(0n)
    const result = await createCampaign(session, 'Title', 'ipfs://meta', 1_000_000n, BigInt(MIN_CAMPAIGN_DURATION_SECONDS))

    expect(result.registered).toBe(true)
    expect(sendCreateMock).toHaveBeenCalledOnce()
    expect(sendRegisterMock).not.toHaveBeenCalled()
  })

  it('createCampaign rejects a mismatched bundle before building create', async () => {
    campaignProgramHashMock.mockReturnValue(new Uint8Array(32).fill(7))

    await expect(createCampaign(session, 'Title', 'ipfs://meta', 1_000_000n, BigInt(MIN_CAMPAIGN_DURATION_SECONDS))).rejects.toThrow(
      /expects Campaign program hash/,
    )
    expect(sendCreateMock).not.toHaveBeenCalled()
    expect(paymentMock).not.toHaveBeenCalled()
  })

  it('verifyDeployment accepts a Registry with the matching Campaign hash', async () => {
    await expect(verifyDeployment()).resolves.toBeUndefined()
  })

  it('verifyDeployment rejects a Registry with another Campaign hash', async () => {
    campaignProgramHashMock.mockReturnValue(new Uint8Array(32).fill(7))

    await expect(verifyDeployment()).rejects.toThrow(
      `the Registry expects Campaign program hash ${'07'.repeat(32)}, but this SDK ships contracts ${SPECS_VERSION}`,
    )
    expect(loggerMock.error).toHaveBeenCalledWith('operation.failed', {
      operation: 'verifyDeployment',
      appId: '1001',
      type: 'registry-mismatch',
    })
  })

  it('verifyDeployment treats a missing Registry hash as a mismatch', async () => {
    campaignProgramHashMock.mockReturnValue(undefined)

    await expect(verifyDeployment()).rejects.toThrow(/Campaign program hash missing/)
  })

  it('verifyDeployment wraps Registry read failures', async () => {
    campaignProgramHashMock.mockRejectedValueOnce(new Error('registry unreachable'))

    await expect(verifyDeployment()).rejects.toThrow('could not read the Registry campaign program hash: registry unreachable')
  })

  it('verifyDeployment classifies a read failure that carries a contract assert', async () => {
    campaignProgramHashMock.mockRejectedValueOnce(new Error('campaign is not open'))

    const error = await verifyDeployment().catch((caught: unknown) => caught)
    expect(error).toMatchObject({ type: 'routing', code: 'campaign-not-open' })
    expect((error as Error).message).toContain('could not read the Registry campaign program hash:')
  })

  it('verifyDeployment stringifies a non-Error Registry failure', async () => {
    campaignProgramHashMock.mockRejectedValueOnce('offline')

    await expect(verifyDeployment()).rejects.toThrow('could not read the Registry campaign program hash: offline')
  })

  it('verifyDeployment rejects a spec without bytecode', async () => {
    delete appSpecMock.byteCode

    await expect(verifyDeployment()).rejects.toThrow(/no byteCode/)
  })

  it('verifyDeployment no-ops without a Registry', async () => {
    registryAppIdMock.mockReturnValue(0n)

    await expect(verifyDeployment()).resolves.toBeUndefined()
    expect(campaignProgramHashMock).not.toHaveBeenCalled()
  })

  it('createCampaign rejects inputs outside the contract bounds', async () => {
    fetchChainTimestampMock.mockResolvedValue(1_000n)
    const minDeadline = 1_000n + BigInt(MIN_CAMPAIGN_DURATION_SECONDS)
    const maxDeadline = 1_000n + BigInt(MAX_CAMPAIGN_DURATION_SECONDS)
    const cases: [string, string, bigint, bigint, RegExp][] = [
      ['', 'ipfs://meta', MIN_GOAL_MICRO_ALGOS, minDeadline, /title is required/],
      ['a'.repeat(MAX_TITLE_BYTES + 1), 'ipfs://meta', MIN_GOAL_MICRO_ALGOS, minDeadline, /title must be at most/],
      ['Title', 'a'.repeat(MAX_METADATA_URI_BYTES + 1), MIN_GOAL_MICRO_ALGOS, minDeadline, /metadata URI must be at most/],
      ['Title', 'ipfs://meta', MIN_GOAL_MICRO_ALGOS - 1n, minDeadline, /goal must be between/],
      ['Title', 'ipfs://meta', MAX_GOAL_MICRO_ALGOS + 1n, minDeadline, /goal must be between/],
      ['Title', 'ipfs://meta', MIN_GOAL_MICRO_ALGOS, minDeadline - 1n, /deadline must be between/],
      ['Title', 'ipfs://meta', MIN_GOAL_MICRO_ALGOS, maxDeadline + 1n, /deadline must be between/],
    ]
    for (const [title, uri, goal, deadline, error] of cases) {
      await expect(createCampaign(session, title, uri, goal, deadline)).rejects.toThrow(error)
    }
    expect(sendCreateMock).not.toHaveBeenCalled()
    expect(paymentMock).not.toHaveBeenCalled()
  })

  it('createCampaign accepts the inclusive contract bounds', async () => {
    fetchChainTimestampMock.mockResolvedValue(1_000n)
    const title = 'a'.repeat(MAX_TITLE_BYTES)
    const uri = 'a'.repeat(MAX_METADATA_URI_BYTES)
    await createCampaign(session, title, uri, MIN_GOAL_MICRO_ALGOS, 1_000n + BigInt(MIN_CAMPAIGN_DURATION_SECONDS))
    await createCampaign(session, title, uri, MAX_GOAL_MICRO_ALGOS, 1_000n + BigInt(MAX_CAMPAIGN_DURATION_SECONDS))
    expect(sendCreateMock).toHaveBeenCalledTimes(2)
  })

  it('deletes without unregistering when no registry is configured', async () => {
    registryAppIdMock.mockReturnValue(0n)
    await deleteCampaign(9n, session)

    expect(composerAddMock).toHaveBeenCalledTimes(1)
    expect(paramsUnregisterMock).not.toHaveBeenCalled()
    expect(composerSendMock).toHaveBeenCalledOnce()
  })

  it('skips the indexer wait when confirmations carry no round', async () => {
    composerSendMock.mockResolvedValue({ confirmations: [] })
    for (const mock of [sendCancelPledgeMock, sendClaimMock, sendDeleteMock]) {
      mock.mockResolvedValue({ confirmation: {} })
    }
    campaignBoxValueMock.mockResolvedValue(new Uint8Array(65).fill(1))

    await pledge(9n, session, 1_000_000n)
    await cancelPledge(9n, session, { position: 2, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })
    await refund(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })
    await claim(9n, session)
    await deleteCampaign(9n, session)
    expect(waitForIndexerRoundMock).not.toHaveBeenCalled()
  })

  it('pledge submits one atomic [pay, pledge, credit] group with a fresh frontier', async () => {
    await pledge(9n, session, 1_000_000n)

    expect(setSignerMock).toHaveBeenCalledWith('ADDRESS', session.signer)
    expect(loadTreeMock).toHaveBeenCalledOnce()
    expect(frontierMock).toHaveBeenCalledOnce()
    expect(paramsPledgeMock).toHaveBeenCalledOnce()
    expect(paramsCreditMock).toHaveBeenCalledOnce()
    // Two app calls in one group (the payment rides along as the pledge's txn arg).
    expect(composerAddMock).toHaveBeenCalledTimes(2)
    expect(composerSendMock).toHaveBeenCalledOnce()
    // Once before building proofs (fresh tree on the first attempt), once after for UI refresh.
    expect(waitForIndexerCatchUpMock).toHaveBeenCalledTimes(2)
  })

  it('pledge keeps a confirmed write successful when the post-send indexer wait fails', async () => {
    waitForIndexerCatchUpMock.mockReset()
    waitForIndexerCatchUpMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('algod unreachable'))

    const result = await pledge(9n, session, 1_000_000n)
    expect(result).toEqual({ txIds: ['GROUP'], confirmedRound: 99n, position: 4, amount: 1_000_000n })
    expect(composerSendMock).toHaveBeenCalledOnce()
    expect(waitForIndexerCatchUpMock).toHaveBeenCalledTimes(2)
    expect(loggerMock.info).toHaveBeenCalledWith('write.confirmed', {
      operation: 'pledge',
      appId: '9',
      txIds: ['GROUP'],
      confirmedRound: '99',
      position: 4,
      amount: '1000000',
    })
  })

  it('logs a write confirmation without a round when the node omits it', async () => {
    composerSendMock.mockResolvedValueOnce({ txIds: ['GROUP'] })

    await pledge(9n, session, 1_000_000n)

    expect(loggerMock.info).toHaveBeenCalledWith('write.confirmed', {
      operation: 'pledge',
      appId: '9',
      txIds: ['GROUP'],
      position: 4,
      amount: '1000000',
    })
  })

  it('pledge rejects amounts outside the contract bounds before building', async () => {
    await expect(pledge(9n, session, MIN_PLEDGE_MICRO_ALGOS - 1n)).rejects.toThrow(/pledge amount must be between/)
    await expect(pledge(9n, session, MAX_PLEDGE_MICRO_ALGOS + 1n)).rejects.toThrow(/pledge amount must be between/)
    expect(loadTreeMock).not.toHaveBeenCalled()
    expect(paramsPledgeMock).not.toHaveBeenCalled()
    expect(paymentMock).not.toHaveBeenCalled()
    expect(loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'pledge',
      appId: '9',
      type: 'validation',
    })
    expect(loggerMock.warn).toHaveBeenCalledTimes(2)
  })

  it('pledge accepts the inclusive amount bounds', async () => {
    await pledge(9n, session, MIN_PLEDGE_MICRO_ALGOS)
    await pledge(9n, session, MAX_PLEDGE_MICRO_ALGOS)
    expect(composerSendMock).toHaveBeenCalledTimes(2)
  })

  it('pledgeGroup returns the built transactions without a group id and without sending', async () => {
    const transactions = [{ txn: { group: new Uint8Array(32) }, signer: 'signer' }]
    composerBuildMock.mockResolvedValue({ transactions })

    const group = await pledgeGroup(9n, session, 1_000_000n)
    expect(group).toBe(transactions)
    expect(transactions[0]?.txn.group).toBeUndefined()
    expect(composerAddMock).toHaveBeenCalledTimes(2)
    expect(composerBuildMock).toHaveBeenCalledOnce()
    expect(composerSendMock).not.toHaveBeenCalled()
    expect(setSignerMock).toHaveBeenCalledWith('ADDRESS', session.signer)
  })

  it('scales the pledge fee with the tree size', async () => {
    loadTreeMock.mockResolvedValue({ leaves: Array.from({ length: 15 }, () => new Uint8Array(32)), raised: 0n })
    await pledgeGroup(9n, session, 1_000_000n)

    const call = paramsPledgeMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(call.extraFee.microAlgo).toEqual(1_000n)
  })

  it('rejects a pledge at the maximum tree size', async () => {
    loadTreeMock.mockResolvedValue({ leaves: { length: Number(MAX_TREE_SIZE) }, raised: 0n })
    const error = await pledgeGroup(9n, session, 1_000_000n).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SdkError)
    expect(error).toMatchObject({ type: 'chain-state', code: 'campaign-max-size', operation: 'pledge', appId: 9n })
    expect((error as Error).message).toContain('maximum size')
  })

  it('pledge retries once on a stale frontier, then throws', async () => {
    composerSendMock.mockRejectedValueOnce(new Error('stale or forged frontier')).mockResolvedValueOnce({})
    await pledge(9n, session, 1_000_000n)
    expect(loadTreeMock).toHaveBeenCalledTimes(2)
    expect(loggerMock.debug).toHaveBeenCalledWith('stale-proof.retry', { operation: 'pledge', appId: '9' })

    composerSendMock
      .mockRejectedValueOnce(new Error('stale or forged frontier'))
      .mockRejectedValueOnce(new Error('stale or forged frontier'))
    await expect(pledge(9n, session, 1_000_000n)).rejects.toThrow('stale or forged frontier')
    expect(loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'pledge',
      appId: '9',
      type: 'stale-proof',
      code: 'stale-proof',
    })

    composerSendMock.mockRejectedValueOnce(new Error('boom'))
    await expect(pledge(9n, session, 1_000_000n)).rejects.toThrow('boom')
  })

  it('scales extra fees with the runtime minimum fee', async () => {
    getSuggestedParamsMock.mockResolvedValue({ minFee: 1_200n })

    await claim(9n, session)
    const claimCall = sendClaimMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(claimCall.extraFee.microAlgo).toEqual(2_400n)

    await deleteCampaign(9n, session)
    const unregisterCall = paramsUnregisterMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    const deleteCall = paramsPledgeMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(unregisterCall.extraFee.microAlgo).toEqual(1_200n)
    expect(deleteCall.extraFee.microAlgo).toEqual(2_400n)
  })

  it('cancelPledge spends one leaf with a fresh path', async () => {
    await cancelPledge(9n, session, { position: 2, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(setSignerMock).toHaveBeenCalledWith('ADDRESS', session.signer)
    expect(pathBlobMock).toHaveBeenCalledOnce()
    expect(sendCancelPledgeMock).toHaveBeenCalledOnce()
    const call = sendCancelPledgeMock.mock.calls[0]?.[0] as {
      args: { k: number; amount: bigint }
      extraFee: { microAlgo: bigint }
      boxReferences: unknown[]
    }
    expect(call.args.k).toEqual(2)
    expect(call.args.amount).toEqual(1_000_000n)
    expect(call.extraFee.microAlgo).toEqual(4_000n)
    expect(call.boxReferences).toHaveLength(1)
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(99n)
  })

  it('cancelPledge logs and throws a final failure', async () => {
    sendCancelPledgeMock.mockRejectedValueOnce(new Error('pledging is closed'))

    await expect(cancelPledge(9n, session, { position: 2, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })).rejects.toThrow(
      'pledging is closed',
    )
    expect(loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'cancelPledge',
      appId: '9',
      type: 'chain-state',
      code: 'pledging-closed',
    })
  })

  it('refund routes through the campaign while the box is open', async () => {
    campaignBoxValueMock.mockResolvedValue(new Uint8Array(65).fill(1))
    await refund(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(setSignerMock).toHaveBeenCalledWith('ADDRESS', session.signer)
    expect(paramsCampaignRefundMock).toHaveBeenCalledOnce()
    expect(paramsVaultRefundMock).not.toHaveBeenCalled()
    expect(composerSendMock).toHaveBeenCalledOnce()
    expect(loggerMock.debug).toHaveBeenCalledWith('refund.route', { appId: '9', route: 'campaign' })
  })

  it('scales the refund fee with the tree size', async () => {
    loadTreeMock.mockResolvedValue({ leaves: Array.from({ length: 100 }, () => new Uint8Array(32)), raised: 0n })
    campaignBoxValueMock.mockResolvedValue(new Uint8Array(65).fill(1))
    await refundGroup(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    const call = paramsCampaignRefundMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(call.extraFee.microAlgo).toEqual(7_000n)
  })

  it('refund routes straight to the vault once settled', async () => {
    const box = new Uint8Array(65)
    box[56] = 2
    campaignBoxValueMock.mockResolvedValue(box)
    await refund(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(setSignerMock).toHaveBeenCalledWith('ADDRESS', session.signer)
    expect(paramsVaultRefundMock).toHaveBeenCalledOnce()
    expect(paramsCampaignRefundMock).not.toHaveBeenCalled()
    expect(loggerMock.debug).toHaveBeenCalledWith('refund.route', { appId: '9', route: 'vault' })
    const call = paramsVaultRefundMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(call.extraFee.microAlgo).toEqual(3_000n)
  })

  it('refund routes through the campaign when no box exists yet', async () => {
    campaignBoxValueMock.mockRejectedValue(new Error('box not found'))
    await refund(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(paramsCampaignRefundMock).toHaveBeenCalledOnce()
  })

  it('refund propagates a non-404 box read error', async () => {
    campaignBoxValueMock.mockRejectedValue(new Error('timeout'))

    await expect(refund(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })).rejects.toThrow('timeout')
    expect(paramsCampaignRefundMock).not.toHaveBeenCalled()
    expect(paramsVaultRefundMock).not.toHaveBeenCalled()
  })

  it('refundGroup returns the built transactions without a group id and without sending', async () => {
    campaignBoxValueMock.mockResolvedValue(new Uint8Array(65).fill(1))
    const transactions = [{ txn: { group: new Uint8Array(32) }, signer: 'signer' }]
    composerBuildMock.mockResolvedValue({ transactions })

    const group = await refundGroup(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })
    expect(group).toBe(transactions)
    expect(transactions[0]?.txn.group).toBeUndefined()
    expect(paramsCampaignRefundMock).toHaveBeenCalledOnce()
    expect(composerSendMock).not.toHaveBeenCalled()
  })

  it('refund retries through the vault when the campaign settles mid-send', async () => {
    campaignBoxValueMock.mockResolvedValueOnce(vaultBox(500n, 0n, 1)).mockResolvedValueOnce(vaultBox(500n, 0n, 2))
    composerSendMock
      .mockRejectedValueOnce(new Error('campaign is not open'))
      .mockResolvedValueOnce({ confirmations: [{ confirmedRound: 99n }] })

    await refund(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(paramsCampaignRefundMock).toHaveBeenCalledOnce()
    expect(paramsVaultRefundMock).toHaveBeenCalledOnce()
    expect(campaignBoxValueMock).toHaveBeenCalledTimes(2)
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(99n)
    expect(loggerMock.debug).toHaveBeenCalledWith('refund.reroute', {
      appId: '9',
      type: 'routing',
      code: 'campaign-not-open',
    })
    expect(loggerMock.warn).not.toHaveBeenCalled()
  })

  it('refund retries through the vault when the campaign app disappears mid-send', async () => {
    campaignBoxValueMock.mockResolvedValueOnce(vaultBox(500n, 0n, 1)).mockResolvedValueOnce(vaultBox(500n, 0n, 2))
    composerSendMock
      .mockRejectedValueOnce(new Error('application 123 not found'))
      .mockResolvedValueOnce({ confirmations: [{ confirmedRound: 99n }] })

    await refund(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(paramsCampaignRefundMock).toHaveBeenCalledOnce()
    expect(paramsVaultRefundMock).toHaveBeenCalledOnce()
  })

  it('refund surfaces a second routing failure', async () => {
    campaignBoxValueMock.mockResolvedValue(vaultBox(500n, 0n, 1))
    composerSendMock.mockRejectedValue(new Error('campaign is not open'))

    await expect(refund(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })).rejects.toThrow('campaign is not open')
    expect(composerSendMock).toHaveBeenCalledTimes(2)
    expect(loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'refund',
      appId: '9',
      type: 'routing',
      code: 'campaign-not-open',
    })
  })

  it('refund does not retry a non-routing failure', async () => {
    campaignBoxValueMock.mockResolvedValue(vaultBox(500n, 0n, 2))
    composerSendMock.mockRejectedValueOnce(new Error('campaign is not refundable'))

    await expect(refund(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })).rejects.toThrow(
      'campaign is not refundable',
    )
    expect(composerSendMock).toHaveBeenCalledOnce()
  })

  it('claim pays the vault-derived total', async () => {
    await claim(9n, session)

    expect(setSignerMock).toHaveBeenCalledWith('ADDRESS', session.signer)
    expect(sendClaimMock).toHaveBeenCalledOnce()
    const call = sendClaimMock.mock.calls[0]?.[0] as { extraFee: unknown; boxReferences: unknown[] }
    expect(call.boxReferences).toHaveLength(1)
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(99n)
  })

  it('settleOpen settles a failed campaign permissionlessly', async () => {
    await settleOpen(9n, session)

    expect(setSignerMock).toHaveBeenCalledWith('ADDRESS', session.signer)
    const call = sendSettleOpenMock.mock.calls[0]?.[0] as {
      args: { app: bigint }
      sender: string
      appReferences: unknown[]
      boxReferences: unknown[]
    }
    expect(call.args.app).toEqual(9n)
    expect(call.sender).toEqual(session.address)
    expect(call.appReferences).toEqual([9n])
    expect(call.boxReferences).toHaveLength(1)
    expect(waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
  })

  it('releaseClaimed releases a claimed box permissionlessly', async () => {
    await releaseClaimed(9n, session)

    expect(setSignerMock).toHaveBeenCalledWith('ADDRESS', session.signer)
    const call = sendReleaseClaimedMock.mock.calls[0]?.[0] as { args: { app: bigint }; boxReferences: unknown[] }
    expect(call.args.app).toEqual(9n)
    expect(call.boxReferences).toHaveLength(1)
    expect(waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
  })

  it('finalize funds the residual inner payment', async () => {
    campaignBoxValueMock.mockResolvedValue(vaultBox(500n, 200n))

    await finalize(9n, session)

    expect(setSignerMock).toHaveBeenCalledWith('ADDRESS', session.signer)
    const call = sendFinalizeMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(call.extraFee.microAlgo).toEqual(1_000n)
    expect(waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
  })

  it('finalize skips the inner fee when the box is fully paid out', async () => {
    campaignBoxValueMock.mockResolvedValue(vaultBox(500n, 500n))

    await finalize(9n, session)

    const call = sendFinalizeMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(call.extraFee.microAlgo).toEqual(0n)
  })

  it('finalize skips the inner fee when the box is missing', async () => {
    campaignBoxValueMock.mockRejectedValue(new Error('box not found'))

    await finalize(9n, session)

    const call = sendFinalizeMock.mock.calls[0]?.[0] as { extraFee: { microAlgo: bigint } }
    expect(call.extraFee.microAlgo).toEqual(0n)
  })

  it('finalize propagates a non-404 box read error', async () => {
    campaignBoxValueMock.mockRejectedValue(new Error('timeout'))

    await expect(finalize(9n, session)).rejects.toThrow('timeout')
    expect(sendFinalizeMock).not.toHaveBeenCalled()
  })

  it('surfaces a cleanup rejection without waiting for the indexer', async () => {
    sendFinalizeMock.mockRejectedValueOnce(new Error('refund window still open'))

    await expect(finalize(9n, session)).rejects.toThrow('refund window still open')
    expect(waitForIndexerCatchUpMock).not.toHaveBeenCalled()
    expect(loggerMock.warn).toHaveBeenCalledWith('operation.failed', {
      operation: 'finalize',
      appId: '9',
      type: 'chain-state',
      code: 'refund-window-open',
    })
  })

  it('deleteCampaign settles, closes, and unregisters in one atomic group', async () => {
    await deleteCampaign(9n, session)

    expect(setSignerMock).toHaveBeenCalledWith('ADDRESS', session.signer)
    expect(paramsUnregisterMock).toHaveBeenCalledOnce()
    expect(paramsPledgeMock).toHaveBeenCalledOnce()
    // Unregister first (references resolve while the app exists), delete second: one group, one approval.
    expect(composerAddMock).toHaveBeenCalledTimes(2)
    expect(composerSendMock).toHaveBeenCalledOnce()
    expect(waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
    expect(sendDeleteMock).not.toHaveBeenCalled()
    expect(sendUnregisterMock).not.toHaveBeenCalled()
  })

  it('fetchVaultBox unpacks the 65-byte box, or undefined when missing', async () => {
    const box = new Uint8Array(65)
    box[56] = 2
    campaignBoxValueMock.mockResolvedValue(box)
    await expect(fetchVaultBox(9n)).resolves.toMatchObject({ status: Number.parseInt(VAULT_BOX_STATUS_FAILED_HEX, 16) })

    campaignBoxValueMock.mockRejectedValue(new Error('box not found'))
    await expect(fetchVaultBox(9n)).resolves.toBeUndefined()

    campaignBoxValueMock.mockRejectedValue(new Error('socket hang up'))
    await expect(fetchVaultBox(9n)).rejects.toThrow('socket hang up')

    campaignBoxValueMock.mockResolvedValue(new Uint8Array(3))
    await expect(fetchVaultBox(9n)).resolves.toBeUndefined()
  })

  it('fetchVaultConfig reads window and sweep target', async () => {
    refundWindowMock.mockResolvedValue(63_072_000n)
    sweepTargetMock.mockResolvedValue('SWEEP')
    await expect(fetchVaultConfig()).resolves.toEqual({ window: 63_072_000n, sweepTarget: 'SWEEP' })
  })

  it('refundWindowEndsAt is settlement plus the configured window', () => {
    expect(refundWindowEndsAt(1_000n, 5n)).toBe(1_005n)
  })
})

describe('isStaleProofError', () => {
  it('matches stale proofs only', () => {
    expect(isStaleProofError(new Error('stale or forged frontier'))).toBe(true)
    expect(isStaleProofError(new Error('proof does not match root'))).toBe(true)
    expect(isStaleProofError(new Error('boom'))).toBe(false)
    expect(isStaleProofError('boom')).toBe(false)
  })
})
