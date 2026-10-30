# expo-mpv, vendored

[expo-mpv](https://github.com/lonzzi/expo-mpv) **0.1.21** (GPL-3.0, see `LICENSE`): libmpv as an Expo view, on mpv-android's
libraries (Android, downloaded by `android/build.gradle` at build time) and MPVKit (iOS, downloaded by the config plugin at
prebuild). Vendored rather than installed from npm so Playpex can change it; the package pins React 19.2.3, the workspace uses 19.3.0.

Copied: `android/`, `ios/`, `cpp/`, `native/`, `plugin/build/`, `src/`, `app.plugin.js`, `expo-module.config.json`, `ExpoMpv.podspec`.
Left out: the example app, tests, the compiled `build/`.

## Playpex's changes (marked `Playpex:` in the code)
- `httpHeaders` prop (`string[]`, `Name: value`): set as mpv's `http-header-fields` right before each `loadfile`
  (Android `MpvPlayer.kt` / `ExpoMpvView.kt` / `ExpoMpvModule.kt`, iOS `ExpoMpvView.swift` / `ExpoMpvModule.swift`,
  `src/ExpoMpv.types.ts`). mpv sends them with every request of the file: the stream, an HLS playlist's segments, `sub-add`
  files. A header value must not contain `,` (the list separator).

- Android `hwdec-codecs`: only the codecs this device has a hardware decoder for (`MpvPlayer.kt#hardwareCodecs`, from
  `MediaCodecList`), not a fixed list: a MediaCodec decoder that fails to start (AV1 on a phone without one) left mpv
  with no video instead of falling back to FFmpeg (dav1d), a black screen with sound.

- Android `consumer-rules.pro` (`consumerProguardFiles`): keeps `expo.modules.mpv.**` and the JNI callbacks from R8;
  without it a release build aborts (`NoSuchMethodError: onEvent`) as soon as the player starts.

- Android playback state `loading` (`MpvPlayer.kt` `awaitingFirstFrame`): from each `loadfile` until mpv's
  `EVENT_PLAYBACK_RESTART` (the first frame at the start position) the state is `loading`, as `ExpoMpv.types.ts` documents;
  upstream sent `playing` as soon as `pause` was off, while mpv was still reading the file (a torrent's MKV index, the seek
  to the resume point), so the app dropped its loading screen for a black one. A file replaced by the next `loadfile` (switching to another
  video of a torrent) ends `stopped` after that `loadfile`: it doesn't end the next file's wait, only an `error` does.

- Android CPU types `arm64-v8a` and `x86_64` only (`android/build.gradle` `mpvAbis`, `abiFilters`), as the app
  (`plugins/with-architectures.js`).

To update: copy a new release over these folders, then apply the changes above again.
