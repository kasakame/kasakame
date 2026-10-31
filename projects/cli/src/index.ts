#!/usr/bin/env node
import { run } from './cli.js'

// WalletConnect leaves relay timers alive after transportClose; the CLI is short-lived.
process.exit(await run(process.argv.slice(2)))
