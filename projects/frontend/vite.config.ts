import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

const require = createRequire(import.meta.url)

// https://vitejs.dev/config/
export default defineConfig({
  // Keep one copy of the runtime deps shared with `@kasakame/sdk`, including when the SDK is swapped in as `file:../sdk` to test unreleased changes.
  resolve: {
    dedupe: ['algosdk', '@algorandfoundation/algokit-utils', '@noble/hashes'],
    // Point the Buffer shim at the ESM build: the CJS path is absolute and collides with the plugin's own `optimizeDeps.exclude` entry, failing dep optimization ("entry cannot be external").
    alias: {
      'vite-plugin-node-polyfills/shims/buffer': require.resolve('vite-plugin-node-polyfills/shims/buffer').replace(/\.cjs$/, '.js'),
    },
  },
  server: {
    fs: {
      // Serve the SDK's dist/ when it is swapped in as `file:../sdk`.
      allow: [searchForWorkspaceRoot(process.cwd()), '../sdk'],
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      globals: {
        Buffer: true,
      },
    }),
  ],
})
