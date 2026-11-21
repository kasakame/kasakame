import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The oracle's view of a campaign tree. */
export interface OracleState {
  n: number
  root: string
  raised: number
}

/** A leaf's refund path as the oracle emits it. */
export interface OraclePath {
  siblings: string[]
  top: string | null
  lower: string[]
}

/** The frontier peaks before an append. */
export interface OracleFrontier {
  peaks: string[]
}

/**
 * One reference-oracle tree (`oracle.py`) with its own state file, so campaigns stay independent.
 */
export class ClaimTreeOracle {
  private readonly file: string

  constructor(prefix = 'claimtree-it-') {
    this.file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'state.json')
    this.cmd('init')
  }

  private cmd(command: string, ...args: string[]): unknown {
    const out = execFileSync('python3', [path.resolve(__dirname, 'oracle.py'), this.file, command, ...args], {
      encoding: 'utf8',
    })
    return JSON.parse(out) as unknown
  }

  /** @returns The current frontier peaks. */
  frontier(): OracleFrontier {
    return this.cmd('frontier') as OracleFrontier
  }

  /**
   * Append a leaf.
   *
   * @param backer Backer address (hex public key).
   * @param amount Pledge amount in microAlgos.
   * @param txidHex Confirmed payment TxID (hex).
   * @returns The resulting tree state.
   */
  append(backer: string, amount: bigint, txidHex: string): OracleState {
    return this.cmd('append', backer, amount.toString(), txidHex) as OracleState
  }

  /**
   * @param k Leaf position.
   * @returns The refund path for the leaf.
   */
  path(k: number): OraclePath {
    return this.cmd('path', k.toString()) as OraclePath
  }

  /**
   * Mark a leaf spent.
   *
   * @param k Leaf position.
   * @param amount Amount spent in microAlgos.
   * @returns The resulting tree state.
   */
  spend(k: number, amount: bigint): OracleState {
    return this.cmd('null', k.toString(), amount.toString()) as OracleState
  }

  /** @returns The current tree state. */
  state(): OracleState {
    return this.cmd('state') as OracleState
  }
}
