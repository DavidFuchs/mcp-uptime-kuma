import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// Linting only: this config has no opinion on layout. Prettier does the formatting (npm run format).
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'scripts/', 'eslint.config.js', 'vitest.config.ts'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // The test config covers src/ as well, so one program serves both.
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A promise nobody awaits is a failure nobody hears about, and in a socket.io listener
      // it is an unhandled rejection. Mark a deliberate one with `void`.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // A leading underscore marks something unused on purpose.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // Test doubles stand in for sockets and servers whose real types would add nothing here.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  }
);
