const { withGradleProperties } = require('expo/config-plugins')

// The CPU types the Android app is built for (gradle.properties `reactNativeArchitectures`): 64-bit ARM
// (every phone since ~2017) and x86_64 (emulators). 32-bit armeabi-v7a is left out: react-native-gesture-handler
// 3.3 (an expo-router dependency) doesn't link against react-native-worklets there, and it halves the APK's
// native libraries (libmpv is large). `expo run:android` still builds only the connected device's type.
module.exports = function withArchitectures(config, architectures = ['arm64-v8a', 'x86_64']) {
  return withGradleProperties(config, (config) => {
    const value = architectures.join(',')
    const existing = config.modResults.find((item) => item.type === 'property' && item.key === 'reactNativeArchitectures')
    if (existing) existing.value = value
    else config.modResults.push({ type: 'property', key: 'reactNativeArchitectures', value })
    return config
  })
}
