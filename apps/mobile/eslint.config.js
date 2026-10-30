// The app's layers (apps/mobile/CLAUDE.md "Layers"), checked by `npm run lint -w apps/mobile`:
//   core      plain TypeScript: no React, no Expo, no other layer of the app
//   native    adapters to native modules; state wires them in
//   state     the bridges between core and React (hooks, providers, queries)
//   features  screens: data from state, no effects, no fetch, no native code
//   ui        the design system: like features, and no data at all
const { defineConfig } = require('eslint/config')
const expo = require('eslint-config-expo/flat')

const effects = [
  { selector: "CallExpression[callee.name='useEffect']", message: 'No effects in screens: derive during render, or use a hook of src/state (useStore, useOwned, useDebouncedValue…).' },
  { selector: "CallExpression[callee.name='useLayoutEffect']", message: 'No effects in screens: use a hook of src/state.' },
  { selector: "CallExpression[callee.property.name='useEffect']", message: 'No effects in screens: use a hook of src/state.' },
  { selector: "CallExpression[callee.name='fetch']", message: 'No fetch in screens: data comes from src/state/queries or a controller.' },
]

module.exports = defineConfig([
  expo,
  { ignores: ['android/**', 'ios/**', 'modules/**', '.expo/**', 'dist/**'] },
  {
    // eslint-plugin-import's rules that parse every imported module: tsc checks the same (names, defaults,
    // unresolved paths), and npm workspaces leave them without the TypeScript parser they look for
    rules: {
      'import/namespace': 'off',
      'import/named': 'off',
      'import/default': 'off',
      'import/no-named-as-default': 'off',
      'import/no-named-as-default-member': 'off',
      'import/no-duplicates': 'off',
      'import/no-unresolved': 'off',
      'import/export': 'off',
    },
  },
  {
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-*', 'react-native*', 'expo', 'expo-*', '@expo/*', '@tanstack/*'], message: 'core is plain TypeScript: native code goes through a port (src/native), React through src/state.' },
            { group: ['**/state/**', '**/features/**', '**/ui/**', '**/native/**', '**/app/**', '**/modules/**'], message: 'core depends on no other layer of the app.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/features/**', 'src/ui/**'],
    rules: {
      'no-restricted-syntax': ['error', ...effects],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/native/**', '**/modules/**'], message: 'Native code is reached through src/state.' },
            { group: ['**/core/http/**'], allowTypeImports: true, message: 'The API client is used by services and controllers, not screens: use src/state.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/ui/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/native/**', '**/modules/**', '**/core/http/**', '**/core/services/**', '**/state/queries*'], allowTypeImports: true, message: 'ui is the design system: it gets its data as props.' },
          ],
        },
      ],
    },
  },
])
