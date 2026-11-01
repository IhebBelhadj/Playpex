const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins')

// The CPU types the Android app is built for (gradle.properties `reactNativeArchitectures`): 64-bit ARM
// (every phone since ~2017) and x86_64 (emulators). 32-bit armeabi-v7a is left out: react-native-gesture-handler
// 3.3 (an expo-router dependency) doesn't link against react-native-worklets there, and it halves the APK's
// native libraries (libmpv is large). `expo run:android` still builds only the connected device's type.
// -Pplaypex.splitAbi=true (a release to hand out) also writes one APK per type, app-arm64-v8a-release.apk for phones,
// half the size; off by default, as `expo run:android` installs the single app-debug.apk.
const MARK = '// playpex: one APK per CPU type'

module.exports = function withArchitectures(config, architectures = ['arm64-v8a', 'x86_64']) {
  config = withAppBuildGradle(config, (config) => {
    if (config.modResults.contents.includes(MARK)) return config
    const include = architectures.map((a) => `'${a}'`).join(', ')
    config.modResults.contents = config.modResults.contents.replace(
      /^android \{/m,
      `android {
    ${MARK}
    splits {
        abi {
            enable findProperty('playpex.splitAbi') == 'true'
            reset()
            include ${include}
            universalApk true
        }
    }`,
    )
    return config
  })
  return withGradleProperties(config, (config) => {
    const value = architectures.join(',')
    const existing = config.modResults.find((item) => item.type === 'property' && item.key === 'reactNativeArchitectures')
    if (existing) existing.value = value
    else config.modResults.push({ type: 'property', key: 'reactNativeArchitectures', value })
    return config
  })
}
