import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./vitest.global-setup.ts'],
    // Shared throwaway DB cleaned with blanket DELETEs: concurrent files would wipe each other's rows.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // App modules only: the listen entry and manually-run scripts/ are not counted.
      include: ['src/app.ts', 'src/auth.ts', 'src/db.ts', 'src/uploads.ts'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
})
