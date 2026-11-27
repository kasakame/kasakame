import {
  runCampaigns,
  runClaim,
  runDelete,
  runFinalize,
  runLogin,
  runLogout,
  runPledges,
  runRefund,
  runReleaseClaimed,
  runSettleOpen,
  runWhoami,
  runWithdraw,
} from '../commands/index.js'
import { cliErrorMessage } from './error-messages.js'
import { configureNetwork } from './network.js'
import type { CliOptions } from './options.js'
import { parseCliOptions } from './parse.js'
import { USAGE } from './usage.js'

/**
 * Run the CLI.
 *
 * @param argv Command-line arguments, excluding the node binary and script path.
 * @returns Process exit code.
 */
export async function run(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }

  let options: CliOptions | undefined
  try {
    options = parseCliOptions(argv)
    switch (options.command) {
      case 'login':
        return await runLogin()
      case 'whoami':
        return await runWhoami(options)
      case 'logout':
        return await runLogout()
      case 'pledges':
        configureNetwork(options)
        return await runPledges(options)
      case 'campaigns':
        configureNetwork(options)
        return await runCampaigns(options)
      case 'refund':
        configureNetwork(options)
        return await runRefund(options)
      case 'withdraw':
        configureNetwork(options)
        return await runWithdraw(options)
      case 'claim':
        configureNetwork(options)
        return await runClaim(options)
      case 'delete':
        configureNetwork(options)
        return await runDelete(options)
      case 'settle-open':
        configureNetwork(options)
        return await runSettleOpen(options)
      case 'finalize':
        configureNetwork(options)
        return await runFinalize(options)
      case 'release-claimed':
        configureNetwork(options)
        return await runReleaseClaimed(options)
    }
  } catch (error) {
    const message = cliErrorMessage(error, options?.command, options?.appId)
    console.error(`Error: ${message}`)
    if (options?.logLevel === 'debug' && error instanceof Error && message !== error.message) {
      console.error(`[detail] ${error.message}`)
    }
    return 1
  }
}
