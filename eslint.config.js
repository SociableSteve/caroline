import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    // Build output and dependencies, matched at any depth rather than only at the repo root.
    // `eslint .` does not read `.gitignore`, so a git-ignored scratch directory is still linted:
    // an agent worktree under `.claude/` carries its own `dist` and `node_modules`, and a
    // top-level-only ignore let that local state fail the lint gate for the whole repo with
    // roughly 1450 errors in files nobody had touched.
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '.claude/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The demo harness in `tools/`: plain Node ESM, run by hand and never by the suite.
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  prettier,
)
