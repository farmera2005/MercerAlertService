// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'packages/db/migrations/**',
      'apps/web/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='rejectUnauthorized'][value.value=false]",
          message:
            'Never disable TLS verification inline. Use SWIS_TLS_INSECURE_SKIP_VERIFY_DEV_ONLY via packages/swis/src/tls.ts.',
        },
      ],
    },
  },
  {
    files: ['scripts/**', 'tools/**/src/cli*.ts', '**/*.test.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
