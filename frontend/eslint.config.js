import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'node_modules']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // JSX element names (including namespaces such as <motion.div>) count as
      // variable uses. Without this, framer-motion's `motion` import is
      // reported as unused.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      // Fetch-on-mount (setState from a loader called in an effect) is a valid
      // React pattern used throughout this app. The rule is kept visible as a
      // warning so new code is reviewed, but it does not block the build.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    // Node-only config and test-harness files.
    files: ['vite.config.js', 'playwright.config.js', 'e2e/**/*.{js,cjs}'],
    languageOptions: {
      globals: globals.node,
      sourceType: 'module',
    },
  },
])
