import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
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
