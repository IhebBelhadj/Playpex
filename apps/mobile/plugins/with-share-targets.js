const fs = require('fs')
const path = require('path')
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins')

// Share to Playpex's direct share (docs/cast-plan.md §5): Android's Share sheet puts
// "<screen> · Playpex" in its top row. The app pushes one sharing shortcut per Playpex screen
// (modules/playpex-device setShareTargets, category SHARE_CATEGORY); this declares the share
// target they belong to (res/xml/playpex_shortcuts.xml, the main activity's
// android.app.shortcuts), for text/plain like the app's own intent filter (app.json).
const SHARE_CATEGORY = 'app.playpex.mobile.category.SHARE_TARGET'
const RESOURCE = 'playpex_shortcuts'

const XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- written by plugins/with-share-targets.js -->
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <share-target android:targetClass="app.playpex.mobile.MainActivity">
    <data android:mimeType="text/plain" />
    <category android:name="${SHARE_CATEGORY}" />
  </share-target>
</shortcuts>
`

module.exports = function withShareTargets(config) {
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const dir = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${RESOURCE}.xml`), XML)
      return config
    },
  ])
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0]
    const main = app?.activity?.find((a) => a.$['android:name'] === '.MainActivity')
    if (main) {
      main['meta-data'] = (main['meta-data'] ?? []).filter((m) => m.$['android:name'] !== 'android.app.shortcuts')
      main['meta-data'].push({ $: { 'android:name': 'android.app.shortcuts', 'android:resource': `@xml/${RESOURCE}` } })
    }
    return config
  })
}

module.exports.SHARE_CATEGORY = SHARE_CATEGORY
