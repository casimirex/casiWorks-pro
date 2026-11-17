import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

const reactRules = {
  ...react.configs.recommended.rules,
  ...react.configs['jsx-runtime'].rules,
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'warn',
  'react/prop-types': 'off',
  'react/no-unknown-property': 'off', // react-three-fiber uses three.js props on JSX
};

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,

  // TypeScript sources
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts', 'scripts/**/*.ts', 'server/**/*.ts', '*.config.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...reactRules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': 'error', // required for Node type stripping
      // `let [a, b] = …` where only some names are reassigned (e.g. swapping) is fine
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },

  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
);
