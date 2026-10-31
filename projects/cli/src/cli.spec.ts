import { afterEach, describe, expect, it, vi } from 'vitest'
import { run } from './cli.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('run', () => {
  it('prints usage with no arguments', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(run([])).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: kasakame'))
  })

  it('prints usage with --help', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(run(['--help'])).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: kasakame'))
  })

  it('prints usage with -h', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(run(['-h'])).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: kasakame'))
  })

  it('rejects a command that is not implemented yet', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(run(['refund'])).toBe(1)
    expect(error).toHaveBeenCalledWith('Not implemented yet: refund')
  })
})
