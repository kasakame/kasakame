import { defineConfig } from 'vitest/config'
import type { TestSpecification } from 'vitest/node'
import { BaseSequencer } from 'vitest/node'

/**
 * Run test files in deterministic path order: the LocalNet suites time-travel the shared dev-mode clock, so their file order is part of the fixture.
 */
class PathOrderSequencer extends BaseSequencer {
  /**
   * @param files The test files to order.
   * @returns The files sorted by module path.
   */
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return Promise.resolve([...files].sort((left, right) => left.moduleId.localeCompare(right.moduleId)))
  }
}

export default defineConfig({
  test: {
    setupFiles: 'vitest.setup.ts',
    environment: 'node',
    globals: true,
    passWithNoTests: true,
    // Spawned CLI runs wait on the indexer and LocalNet block time.
    testTimeout: 120_000,
    // Run test files by path, not by Vitest's default size/duration order.
    sequence: { sequencer: PathOrderSequencer },
    tags: [
      { name: 'smoke', description: 'The built binary and one read/write per command family.' },
      { name: 'happy', description: 'Successful user flows.' },
      { name: 'bad', description: 'Rejection and adversarial paths.' },
      { name: 'always', description: 'Independent test; runs alone.' },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The bin entry only wires run() to process.exitCode; behavior is covered through src/app/run.ts.
      exclude: ['src/index.ts', 'src/**/*.spec.ts', 'src/commands/test-fixtures.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
})
