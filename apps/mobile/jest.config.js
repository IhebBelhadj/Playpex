// Unit tests: `npm test -w apps/mobile`. Test files sit next to what they test, in __tests__ folders.
//   core      plain TypeScript: Node's own fetch / Request / Response, no React Native
//   app       state, features, ui: jest-expo's React Native environment
// babel-preset-expo is nested in expo (npm workspaces): resolve it from there
const expoPreset = require.resolve('babel-preset-expo', { paths: [require.resolve('expo/package.json')] })
const babel = { '^.+\\.[jt]sx?$': ['babel-jest', { presets: [expoPreset] }] }

// The workspace root holds the TV app's older @babel/runtime (Angular's); Expo's own is nested in expo
const babelRuntime = { '^@babel/runtime/(.*)$': '<rootDir>/../../node_modules/expo/node_modules/@babel/runtime/$1' }

module.exports = {
  projects: [
    {
      displayName: 'core',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/core/**/__tests__/**/*.test.ts'],
      transform: babel,
      moduleNameMapper: babelRuntime,
      transformIgnorePatterns: ['node_modules/(?!(openapi-fetch|@playpex)/)'],
    },
    {
      displayName: 'app',
      preset: 'jest-expo',
      testMatch: ['<rootDir>/src/{state,features,ui,native}/**/__tests__/**/*.test.ts?(x)'],
      moduleNameMapper: babelRuntime,
      // ES modules jest must transform (jest-expo's list + the API client)
      transformIgnorePatterns: [
        'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-svg|openapi-fetch|@playpex/.*)',
      ],
    },
  ],
}
