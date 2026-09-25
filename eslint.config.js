import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'e2e/scenarios/**/dist'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    // Test apps and examples mirror real user code, including decorators and loose typing.
    files: ['test/**', 'examples/**', 'e2e/**'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    // AdonisJS registers config types through empty interfaces (declaration merging).
    files: ['e2e/scenarios/adonisjs*/config/**'],
    rules: { '@typescript-eslint/no-empty-object-type': 'off' },
  },
  {
    // Koa 1 route handlers are generators that do not always yield.
    files: ['e2e/scenarios/koa1-*/**'],
    rules: { 'require-yield': 'off' },
  },
  {
    // CommonJS e2e apps check the require() entry points on purpose.
    files: ['e2e/scenarios/*-cjs/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
