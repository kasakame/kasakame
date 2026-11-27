import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import importPlugin from 'eslint-plugin-import'
import jsdoc from 'eslint-plugin-jsdoc'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import tailwindcss from 'eslint-plugin-tailwindcss'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  {
    ignores: ['node_modules/', 'dist/', 'coverage/'],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs', 'vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      // Classic React 18 hooks rules; the newer "compiler" rules are skipped because this project does not use the React Compiler.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // PropTypes are redundant when components are fully typed with TypeScript.
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off', // not needed with the new JSX transform
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  // JSDoc rules, scoped to exported/public declarations so internal helpers need no doc block.
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    plugins: { jsdoc },
    rules: {
      ...jsdoc.configs['flat/recommended-typescript-error'].rules,
      'jsdoc/require-jsdoc': ['error', { publicOnly: true }],
      'jsdoc/require-returns': ['error', { publicOnly: true }],
      // Match prettier-plugin-jsdoc: one blank line between the description and the first tag.
      'jsdoc/tag-lines': ['error', 'never', { startLines: 1 }],
    },
  },
  // Import rules: duplicates and named-default safety; ordering is handled by `prettier-plugin-organize-imports`.
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    plugins: { import: importPlugin },
    rules: {
      // Resolution rules are skipped: `tsc --noEmit` validates module resolution, and the default resolver cannot read `exports`-only packages.
      'import/no-duplicates': 'error',
      'import/no-named-as-default': 'error',
      'import/no-named-as-default-member': 'error',
    },
  },
  // Tailwind classes (tsx only). Prettier does not sort them, so ordering lives here; custom theme colors need the v4 stylesheet below to resolve.
  {
    files: ['**/*.tsx'],
    plugins: { tailwindcss },
    settings: {
      tailwindcss: {
        cssConfigPath: './src/styles/App.css',
      },
    },
    rules: {
      'tailwindcss/classnames-order': 'error',
      'tailwindcss/no-contradicting-classname': 'error',
      'tailwindcss/no-custom-classname': 'error',
      'tailwindcss/enforces-shorthand': 'error',
      'tailwindcss/no-unnecessary-arbitrary-value': 'error',
      'tailwindcss/enforces-canonical-classname': 'error',
      'tailwindcss/enforces-negative-arbitrary-values': 'error',
      'tailwindcss/important-modifier-suffix': 'error',
    },
  },
  // Test files get Vitest globals.
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
    },
    rules: {
      // Vitest mocks return `any`; relaxing these keeps test files from fighting the type-checker over mock factories.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  prettier,
)
