#!/usr/bin/env node
'use strict'

// A release of Playpex Mobile for Android (npm run release:mobile): prebuild (the signing and per-CPU plugins),
// Gradle's signed release with one APK per CPU type, then release/Playpex-<version>-<cpu>.apk + SHA256SUMS to
// attach to the GitHub release `android-v<version>`. Needs PLAYPEX_ANDROID_SIGNING (the release key's properties
// file, plugins/with-release-signing.js), the Android SDK (ANDROID_HOME, default ~/Android/Sdk) and JDK 21
// (JAVA_HOME, default ~/.local/jdk-21). Bump `expo.version` and `expo.android.versionCode` in app.json first:
// phones only update to a higher versionCode.

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(__dirname, '..')
const home = os.homedir()
const env = {
  ...process.env,
  ANDROID_HOME: process.env.ANDROID_HOME || path.join(home, 'Android/Sdk'),
  JAVA_HOME: process.env.JAVA_HOME || path.join(home, '.local/jdk-21'),
}
if (!env.PLAYPEX_ANDROID_SIGNING || !fs.existsSync(env.PLAYPEX_ANDROID_SIGNING)) {
  console.error('PLAYPEX_ANDROID_SIGNING must name the release key\'s properties file (storeFile, storePassword, keyAlias, keyPassword)')
  process.exit(1)
}

const { version, android } = require(path.join(root, 'app.json')).expo
console.log(`Playpex Mobile ${version} (versionCode ${android.versionCode})`)
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, env, stdio: 'inherit' })
run('npx', ['expo', 'prebuild', '-p', 'android', '--no-install'], root)
fs.writeFileSync(path.join(root, 'android/local.properties'), `sdk.dir=${env.ANDROID_HOME}\n`)
run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', ['assembleRelease', '-q', '-Pplaypex.splitAbi=true'], path.join(root, 'android'))

const built = path.join(root, 'android/app/build/outputs/apk/release')
const out = path.join(root, 'release')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out)
const sums = []
for (const [cpu, name] of [['arm64-v8a', 'arm64'], ['x86_64', 'x86_64']]) {
  const file = `Playpex-${version}-${name}.apk`
  fs.copyFileSync(path.join(built, `app-${cpu}-release.apk`), path.join(out, file))
  sums.push(`${crypto.createHash('sha256').update(fs.readFileSync(path.join(out, file))).digest('hex')}  ${file}`)
}
fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums.join('\n') + '\n')
console.log(`\n${out}:\n${sums.join('\n')}\nAttach them to the GitHub release android-v${version} (a pre-release while it's an alpha).`)
