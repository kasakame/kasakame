import { fetchMyLeaves, type BackerLeaf, type WalletSession, type WriteConfirmation } from '@kasakame/sdk'
import type { CliOptions } from '../args.js'
import { cliErrorMessage } from '../errors.js'
import { openCliSession } from '../session.js'
import { announceSubmit, formatAlgo, pledges, printConfirmation, progress } from './format.js'

export interface SpendLabel {
  verb: string
  done: string
}

/**
 * Spend every live leaf of the signer, one wallet approval per leaf, and report partial failures.
 *
 * @param options Parsed CLI options.
 * @param appId Campaign application id.
 * @param label Words for the progress and summary lines.
 * @param spend Submits one leaf spend through the wallet session.
 * @returns Process exit code.
 */
export async function spendLeaves(
  options: CliOptions,
  appId: bigint,
  label: SpendLabel,
  spend: (wallet: WalletSession, leaf: BackerLeaf) => Promise<WriteConfirmation>,
): Promise<number> {
  const session = await openCliSession(options)
  try {
    const leaves = await fetchMyLeaves(appId, session.wallet.address)
    if (leaves.length === 0) {
      console.log(`No live pledges to ${label.verb} from campaign ${appId.toString()}.`)
      return 0
    }
    const selected = selectLeaves(leaves, options, appId)

    if (options.dryRun) {
      for (const leaf of selected) {
        console.log(`Would ${label.verb} pledge #${String(leaf.position)} (${formatAlgo(leaf.amount)} ALGO).`)
      }
      console.log(`Dry run: ${pledges(selected.length)} would be ${label.done.toLowerCase()}.`)
      return 0
    }

    if (selected.length > 1) {
      progress(
        options.signer === 'wallet'
          ? `${pledges(selected.length)} selected; your wallet asks for approval on each one.`
          : `${pledges(selected.length)} selected; each is a separate transaction.`,
      )
    }

    let failed = 0
    for (const leaf of selected) {
      try {
        announceSubmit(options, `${label.verb} pledge #${String(leaf.position)} (${formatAlgo(leaf.amount)} ALGO)`)
        const confirmation = await spend(session.wallet, leaf)
        console.log(`${label.done} pledge #${String(leaf.position)} (${formatAlgo(leaf.amount)} ALGO).`)
        printConfirmation(confirmation, options.network)
      } catch (error) {
        failed += 1
        const message = cliErrorMessage(error, options.command, appId)
        console.error(`Pledge #${String(leaf.position)} failed: ${message}`)
        if (options.logLevel === 'debug' && error instanceof Error && message !== error.message) {
          console.error(`[detail] ${error.message}`)
        }
      }
    }

    if (failed > 0) {
      console.error(`${label.done} ${String(selected.length - failed)} of ${String(selected.length)} pledges; ${String(failed)} failed.`)
      return 1
    }
    console.log(`${label.done} ${pledges(selected.length)}.`)
    return 0
  } finally {
    await session.close()
  }
}

function selectLeaves(leaves: BackerLeaf[], options: CliOptions, appId: bigint): BackerLeaf[] {
  if (options.pledge !== undefined) {
    const leaf = leaves.find((candidate) => candidate.position === options.pledge)
    if (leaf === undefined) {
      throw new Error(`No live pledge #${String(options.pledge)} in campaign ${appId.toString()}`)
    }
    return [leaf]
  }
  if (options.all === true || leaves.length === 1) {
    return leaves
  }
  throw new Error(`You have ${String(leaves.length)} live pledges in campaign ${appId.toString()}; pass --pledge <position> or --all`)
}
