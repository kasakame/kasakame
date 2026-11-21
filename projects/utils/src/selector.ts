import { createHash } from 'node:crypto'

/**
 * @param signature An ARC-4 method signature.
 * @returns The 4-byte selector as hex.
 */
export function selectorOf(signature: string): string {
  return createHash('sha512-256').update(signature).digest('hex').slice(0, 8)
}
