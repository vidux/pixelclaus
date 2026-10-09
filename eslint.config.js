import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'tmp/**',
      'packages/viewer/vite.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    files: ['packages/core/src/**/*.ts', 'packages/formats/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'fs',
            'path',
            'os',
            'zlib',
            'crypto',
            'buffer',
            'child_process',
            'http',
            'https',
            'url',
            'util',
            'stream',
            'sharp',
            'express',
          ].map((name) => ({
            name,
            message: 'core/formats must stay browser-safe (no Node APIs).',
          })),
          patterns: [
            { group: ['node:*', 'fs/*'], message: 'core/formats must stay browser-safe (no Node APIs).' },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { URL: 'readonly', process: 'readonly', console: 'readonly' } },
  },
  {
    files: ['packages/viewer/src/**/*.ts'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly', fetch: 'readonly' } },
  },
);
