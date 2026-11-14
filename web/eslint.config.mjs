import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist/**', 'src/api-schema.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Every hooks rule is an error, the compiler-oriented ones included: the screens they flagged have migrated.
  reactHooks.configs.flat['recommended-latest'],
  {
    rules: {
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/purity': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx,mjs}'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        RequestInit: 'readonly',
      },
    },
  },
);
