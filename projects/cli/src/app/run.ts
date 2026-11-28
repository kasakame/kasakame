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
import { createCommandContext } from './context.js'
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
  let context: ReturnType<typeof createCommandContext> | undefined
  try {
    options = parseCliOptions(argv)
    context = createCommandContext(options)
    switch (options.command) {
      case 'login':
        return await runLogin(context)
      case 'whoami':
        return await runWhoami(context)
      case 'logout':
        return await runLogout(context)
      case 'pledges':
        configureNetwork(options)
        return await runPledges(context)
      case 'campaigns':
        configureNetwork(options)
        return await runCampaigns(context)
      case 'refund':
        configureNetwork(options)
        return await runRefund(context)
      case 'withdraw':
        configureNetwork(options)
        return await runWithdraw(context)
      case 'claim':
        configureNetwork(options)
        return await runClaim(context)
      case 'delete':
        configureNetwork(options)
        return await runDelete(context)
      case 'settle-open':
        configureNetwork(options)
        return await runSettleOpen(context)
      case 'finalize':
        configureNetwork(options)
        return await runFinalize(context)
      case 'release-claimed':
        configureNetwork(options)
        return await runReleaseClaimed(context)
    }
    /* v8 ignore next - the command union is exhaustive; keeps noImplicitReturns satisfied */
    return 1
  } catch (error) {
    const message = cliErrorMessage(error, options?.command, options?.appId)
    console.error(`Error: ${message}`)
    if (options?.logLevel === 'debug' && error instanceof Error && message !== error.message) {
      console.error(`[detail] ${error.message}`)
    }
    return 1
  } finally {
    await context?.close()
  }
}
