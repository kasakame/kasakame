import { puyaTsTransformer } from '@algorandfoundation/algorand-typescript-testing/vitest-transformer'
import typescript from '@rollup/plugin-typescript'
import { defineConfig } from 'vitest/config'
import type { TestSpecification } from 'vitest/node'
import { BaseSequencer } from 'vitest/node'

/**
 * Run test files in deterministic path order (numbered LocalNet suites, no time-travel overlap).
 */
class PathOrderSequencer extends BaseSequencer {
  /**
   * @param files The test files to order.
   * @returns The files sorted by module path.
   */
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((left, right) => left.moduleId.localeCompare(right.moduleId))
  }
}

export default defineConfig({
  test: {
    setupFiles: 'vitest.setup.ts',
    // Run test files by path, not by Vitest's default size/duration order.
    sequence: { sequencer: PathOrderSequencer },
    // LocalNet integration tests deploy apps and fast-forward blocks, which occasionally exceeds the default 5s test timeout.
    testTimeout: 120_000,
    // The first deployStack can exceed Vitest's 10s hook default on a cold LocalNet and would skip the file.
    hookTimeout: 120_000,
    tags: [
      { name: 'smoke', description: 'Deployment and basic happy-path integration.' },
      { name: 'happy', description: 'Successful user flows.' },
      { name: 'bad', description: 'Rejection and adversarial paths.' },
      { name: 'scale', description: 'Large-N and many-campaign stress cases.', timeout: 600_000 },
      { name: 'always', description: 'Independent test; runs alone and after unrelated failures.' },
      { name: 'chain', description: 'Ordered test; shares state with earlier tests in its file.' },
    ],
    // Coverage measures the contract source only: V8 tracks the puya-transformed code back to `.algo.ts`.
    coverage: {
      provider: 'v8',
      include: ['smart_contracts/**/*.algo.ts'],
      exclude: ['**/*.algo.spec.ts', '**/*.algo.test.ts', 'smart_contracts/artifacts/**'],
      reporter: ['text', 'json-summary'],
      // Statements stays un-thresholded: the `@abimethod` decorator wraps each signature in a statement V8 never marks.
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
      },
    },
  },
  plugins: [
    typescript({
      tsconfig: './tsconfig.json',
      // The contract tsconfig emits CommonJS; Vitest needs ESM so runtime-helpers resolves through the exports map.
      compilerOptions: { module: 'esnext', moduleResolution: 'bundler' },
      transformers: {
        before: [puyaTsTransformer],
      },
    }),
  ],
})
