import { defineConfig } from 'vitest/config'
import type { TestSpecification } from 'vitest/node'
import { BaseSequencer } from 'vitest/node'

/**
 * Run test files in deterministic path order.
 *
 * Vitest's default sequencer runs the largest files first, and failed/longer files first when it has a results cache.
 * The SDK LocalNet suites are numbered `00`-`04`, so path order keeps the CI log readable and reproducible. The files
 * are independent: each deploys its own stack, and `--no-file-parallelism` keeps their chain-global time travel from
 * overlapping.
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

// https://vitest.dev/config/
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    passWithNoTests: true,
    // Run test files by path, not by Vitest's default size/duration order.
    sequence: { sequencer: PathOrderSequencer },
    tags: [
      { name: 'smoke', description: 'Deployment and basic SDK send-path integration.' },
      { name: 'happy', description: 'Successful user flows.' },
      { name: 'bad', description: 'Rejection and adversarial paths.' },
      { name: 'scale', description: 'Mid-size and large tree proof paths.', timeout: 600_000 },
      { name: 'always', description: 'Independent test; runs alone and after unrelated failures.' },
      { name: 'chain', description: 'Ordered test; shares state with earlier tests in its file.' },
    ],
    // LocalNet integration tests deploy apps and fast-forward blocks, which exceeds the default 5s timeout.
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      // The SDK is utils: same 100% gate as the frontend. Genuinely unreachable defensive
      // branches carry `/* v8 ignore next */` with a reason instead of theater tests.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/generated/**', 'test/**'],
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
