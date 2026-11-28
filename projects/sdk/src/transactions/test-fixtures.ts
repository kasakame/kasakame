import { programHash } from '@kasakame/utils'
import type { TransactionSigner } from 'algosdk'
import algosdk from 'algosdk'
import { type Mock, vi } from 'vitest'

function mock(): Mock {
  return vi.fn()
}

export const sendCreateMock = mock()
export const sendRegisterMock = mock()
export const sendUnregisterMock = mock()
export const sendClaimMock = mock()
export const sendCancelPledgeMock = mock()
export const sendDeleteMock = mock()
export const sendFinalizeMock = mock()
export const sendReleaseClaimedMock = mock()
export const sendSettleOpenMock = mock()
export const paramsPledgeMock = mock()
export const paramsCreditMock = mock()
export const paramsCampaignRefundMock = mock()
export const paramsVaultRefundMock = mock()
export const paramsUnregisterMock = mock()
export const paymentMock = mock()
export const composerAddMock = mock()
export const composerBuildMock = mock()
export const composerSendMock = mock()
export const setSignerMock = mock()
export const campaignBoxValueMock = mock()
export const refundWindowMock = mock()
export const sweepTargetMock = mock()
export const waitForIndexerRoundMock = mock()
export const waitForIndexerCatchUpMock = mock()
export const fetchChainTimestampMock = mock()
export const loadTreeMock = mock()
export const clearTreeCacheMock = mock()
export const frontierMock = mock()
export const pathBlobMock = mock()
export const registryAppIdMock = mock()
export const getSuggestedParamsMock = mock()
export const campaignProgramHashMock = mock()

export const appSpecMock: { name: string; byteCode?: { approval: string; clear: string } } = {
  name: 'Campaign',
  byteCode: { approval: 'AA==', clear: 'AQ==' },
}

export const loggerMock = { debug: mock(), info: mock(), warn: mock(), error: mock() }

export const campaignClientModule = {
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
}

export const vaultClientModule = {
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
}

export const registryClientModule = {
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
}

export const runtimeLogModule = { sdkLogger: () => loggerMock }

export const runtimeConfigModule = {
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
}

export const runtimeIndexerModule = {
  waitForIndexerRound: (...args: unknown[]) => waitForIndexerRoundMock(...args),
  waitForIndexerCatchUp: (...args: unknown[]) => waitForIndexerCatchUpMock(...args),
  waitForIndexerCatchUpBestEffort: async (...args: unknown[]) => {
    try {
      await waitForIndexerCatchUpMock(...args)
    } catch {
      // The write is confirmed; the next read retries.
    }
  },
}

export const runtimeClockModule = {
  fetchChainTimestamp: (...args: unknown[]) => fetchChainTimestampMock(...args),
}

export const session = {
  address: 'ADDRESS',
  signer: (() => new Uint8Array()) as unknown as TransactionSigner,
}

// The real app-account address of the configured vault (app id 2002).
export const VAULT_APP_ADDRESS = algosdk.getApplicationAddress(2002n).toString()

/**
 * A packed vault box with the given inflow/outflow totals.
 *
 * @param paidIn Total inflows in microAlgos.
 * @param paidOut Total outflows in microAlgos.
 * @param status Vault box status byte (1 Open, 2 Failed, 3 Claimed).
 * @returns The 65-byte vault box.
 */
export function vaultBox(paidIn: bigint, paidOut: bigint, status = 0): Uint8Array {
  const box = new Uint8Array(65)
  const view = new DataView(box.buffer)
  view.setBigUint64(0, paidIn)
  view.setBigUint64(8, paidOut)
  box[56] = status
  return box
}

/** Reset every transaction mock to its default happy-path value. */
export function resetMocks(): void {
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
}
