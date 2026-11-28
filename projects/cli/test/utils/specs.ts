import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '../../../..')

/** The three ARC-56 specs the CLI tests deploy. */
export interface CliSpecs {
  campaign: Arc56Contract
  registry: Arc56Contract
  vault: Arc56Contract
}

function read(file: string): Arc56Contract {
  if (!fs.existsSync(file)) {
    throw new Error(`${file} not found; run \`npm run build\` in projects/contracts or drop CLI_SPECS=local`)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Arc56Contract
}

/**
 * Load the Registry and ClaimsVault specs matching the SDK the CLI runs; `CLI_SPECS=local` reads the contracts build.
 *
 * @returns The deployed specs.
 */
export function loadCliSpecs(): CliSpecs {
  const local = process.env.CLI_SPECS === 'local'
  const base = local
    ? path.join(repoRoot, 'projects/contracts/smart_contracts/artifacts')
    : path.join(path.dirname(require.resolve('@kasakame/contracts/package.json')), 'dist/arc56')
  return {
    campaign: read(path.join(base, 'campaign', 'Campaign.arc56.json')),
    registry: read(path.join(base, 'registry', 'Registry.arc56.json')),
    vault: read(path.join(base, 'claimsvault', 'ClaimsVault.arc56.json')),
  }
}
