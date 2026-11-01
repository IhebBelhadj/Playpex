const { withAppBuildGradle } = require('expo/config-plugins')

// Release builds signed with the publisher's key (android/ is generated, so this goes in at prebuild). The key
// never lives in the repository: PLAYPEX_ANDROID_SIGNING names a properties file (storeFile, storePassword,
// keyAlias, keyPassword; the publisher's is ~/projects/playpex-keys/android-release.properties). Every update must be
// signed with the same key, or phones refuse it: without the file a release build stops, unless
// -Pplaypex.debugSigning=true asks for the debug key (a build to try on your own phone, never to hand out).
const MARK = '// playpex: release signing'

const SIGNING = `
${MARK}
def playpexSigning = System.getenv('PLAYPEX_ANDROID_SIGNING')
def playpexKey = new Properties()
if (playpexSigning && file(playpexSigning).exists()) {
    file(playpexSigning).withInputStream { playpexKey.load(it) }
}
`

const CONFIG = `
        release {
            if (playpexKey['storeFile']) {
                storeFile file(playpexKey['storeFile'])
                storePassword playpexKey['storePassword']
                keyAlias playpexKey['keyAlias']
                keyPassword playpexKey['keyPassword']
            }
        }`

const CHECK = `
gradle.taskGraph.whenReady { graph ->
    def releasing = graph.allTasks.any { it.project == project && it.name.toLowerCase().contains('release') && it.name.startsWith('assemble') }
    if (releasing && !playpexKey['storeFile'] && findProperty('playpex.debugSigning') != 'true') {
        throw new GradleException('No release key: set PLAYPEX_ANDROID_SIGNING to its properties file (or -Pplaypex.debugSigning=true for a build signed with the debug key)')
    }
}
`

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    let gradle = config.modResults.contents
    if (gradle.includes(MARK)) return config
    gradle = gradle.replace(/^android \{/m, SIGNING + '\nandroid {')
    // the release signing config, next to the template's debug one
    gradle = gradle.replace(/(signingConfigs \{\s*debug \{[^}]*\})/, `$1${CONFIG}`)
    // the release build type uses it when there is a key
    gradle = gradle.replace(
      /(release \{\s*\/\/ Caution![^\n]*\n[^\n]*\n\s*)signingConfig signingConfigs\.debug/,
      '$1signingConfig playpexKey[\'storeFile\'] ? signingConfigs.release : signingConfigs.debug',
    )
    config.modResults.contents = gradle + CHECK
    return config
  })
}
