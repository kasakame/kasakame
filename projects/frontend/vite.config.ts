import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

const require = createRequire(import.meta.url)

// https://vitejs.dev/config/
export default defineConfig({
  // Keep one copy of the runtime deps shared with `@kasakame/sdk`; also needed
  // when the SDK is swapped in as `file:../sdk` to test unreleased changes.
  resolve: {
    dedupe: ['algosdk', '@algorandfoundation/algokit-utils', '@noble/hashes'],
    // vite-plugin-node-polyfills injects this Buffer shim into every module
    // that uses the global - including the SDK's dist/, which sits outside
    // this package and cannot resolve the plugin's node_modules from there.
    // Point at the ESM build: `require.resolve` would pick the CJS file,
    // which collides with the plugin's own `optimizeDeps.exclude` entry
    // (absolute .cjs path) and fails dep optimization ("entry cannot be
    // external") when Vite discovers the injected import at serve time.
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
