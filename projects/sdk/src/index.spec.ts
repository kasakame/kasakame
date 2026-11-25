import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import * as sdk from './index.js'
import { SPECS_VERSION } from './index.js'

const require = createRequire(import.meta.url)
const contractsPackage = require('../../contracts/package.json') as { version: string }

// The public runtime surface: adding, removing, or renaming an export requires an explicit update here and in docs/sdk.md.
const PUBLIC_EXPORTS = [
  'MAX_TREE_SIZE',
  'SPECS_VERSION',
  'SdkError',
  'appendLeaf',
  'base32ToBytes',
  'campaignFromHeader',
  'cancelPledge',
  'claim',
  'classifyChainError',
  'clearCachedCampaigns',
  'clearTreeCache',
  'concatHashes',
  'configureSdk',
  'createCampaign',
  'decodeGlobalState',
  'deleteCampaign',
  'emptyTree',
  'enumerateCampaigns',
  'fetchCampaignHeader',
  'fetchChainTimestamp',
  'fetchMyLeaves',
  'fetchMyPledge',
  'fetchPledges',
  'fetchRegisteredCampaignIds',
  'fetchSpends',
  'fetchVaultBox',
  'fetchVaultConfig',
  'finalize',
  'foldPeaks',
  'frontierForPledge',
  'getCachedCampaigns',
  'getCampaign',
  'getCampaignStatus',
  'getSdkConfig',
  'hashPair',
  'isCampaignApp',
  'isRegistered',
  'isStaleProofError',
  'leafFor',
  'listCampaigns',
  'loadTree',
  'nullLeaf',
  'pathBlobForRefund',
  'pathShape',
  'pledge',
  'pledgeGroup',
  'pledgeOpUpIterations',
  'refund',
  'refundGroup',
  'refundOpUpIterations',
  'refundWindowEndsAt',
  'registerCampaign',
  'releaseClaimed',
  'setCachedCampaigns',
  'settleOpen',
  'toCampaignViewModel',
  'treeFrontier',
  'treePathFor',
  'treeRoot',
  'u64be',
  'u64beDecode',
  'vaultAddress',
  'verifyDeployment',
  'waitForIndexerCatchUp',
  'waitForIndexerRound',
  'zeroLeaf',
]

describe('public exports', () => {
  it('match the documented runtime surface', () => {
    expect(Object.keys(sdk).sort()).toEqual(PUBLIC_EXPORTS)
  })
})

describe('SPECS_VERSION', () => {
  it('matches the contracts package version', () => {
    expect(SPECS_VERSION).toBe(contractsPackage.version)
  })
})
