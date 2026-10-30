# Playpex Server Manager (`apps/manager`) — Agent Guide

An Android app (Capacitor 8) for managing a Playpex Media Server from a phone: it finds the servers on the Wi-Fi by
itself and opens the chosen server's dashboard (`apps/dashboard`, served by that server) in its WebView. Nobody types
an IP address. iOS comes later (needs an Apple developer account; `NSBonjourServices` `_playpex._tcp`,
`NSLocalNetworkUsageDescription`, `NSAllowsLocalNetworking`).

## How it works
```
app start ─► src/main.ts (the app's own page, https://localhost)
              ├─ last server saved (localStorage `playpex.manager.last`) and it answers within 3 s ─► open it
              └─ else the picker: servers found on this network + "Enter an address"
                   ▲ events "server" from the native plugin
android/.../PlaypexDiscovery.java (registered in MainActivity)
   mDNS: NsdManager browses `_playpex._tcp`, resolves each service (one at a time)
   UDP:  `PLAYPEX_DISCOVER 1` to 255.255.255.255 + each network's broadcast address, port 28471, every 5 s
   each address confirmed with GET <address>/api/v1/server (id must match TXT / the UDP answer), reported once per
   server and address; probe(address) does the same for a typed address (no port = 28470)
open(server) ─► location.href = http://<address>:<port>/ (the server's dashboard; sign in as its admin)
no network at all (nor this phone's hotspot / USB tethering) ─► "No connection" (picker)
dashboard can't load, or its server stops answering after a network change ─► https://localhost/#offline=<page URL>
   (android/.../PlaypexConnection.java) ─► "No connection" / "Can't reach <server>" (only whether it answers counts), retried every 5 s and
   on every network change; back to that page once the server answers
dashboard ─► "Switch server" (components/layout.tsx, only when the user agent has `PlaypexManager/`) ─► https://localhost/#pick
```
The checks are native because the picker's page (https://localhost) may not read a LAN server's answers (mixed
content, CORS). The protocol is the one every client follows: [`docs/api/discovery.md`](../../docs/api/discovery.md).

## Files
| Path | What |
|---|---|
| `src/main.ts` | the picker: the last server opened at once at launch only (sessionStorage `playpex.manager.autoOpened`: Back from its dashboard lands on the list, a second Back leaves), last server first, the list (redrawn alone, so typing is never interrupted), the address form, the "none found" hint after 8 s |
| `src/connection.ts` | the connection plugin's TypeScript side (`registerPlugin('PlaypexConnection')`): `network()` (`connected`: any network; `local`: Wi-Fi, Ethernet, this phone's hotspot or USB tethering), the `network` event, `wifiSettings()`; in a browser `navigator.onLine` |
| `android/.../PlaypexConnection.java` | watches every network (`registerNetworkCallback`, VPNs too, so the Wi-Fi under one counts) and, every 3 s while in the foreground, the interfaces (the hotspot / USB tethering send no callbacks and aren't networks to Android: `wlan*`, `swlan*`, `ap*`, `rndis*`, `ncm*`… with a private IPv4); never "Not on Wi-Fi": a computer on the phone's hotspot is on the LAN while the phone itself is on mobile data; its `BridgeWebViewClient` sends a dashboard's failed main-frame load to `#offline=<url>` instead of Chromium's error page; after any network change (2.5 s to settle) asks the dashboard's server again (`PlaypexDiscovery.check`) and shows the same screen when it doesn't answer; `wifiSettings()` opens the Wi-Fi panel (Android 10+) or Wi-Fi settings. Back on that screen sends the app to the background (`AppChrome`) |
| `src/discovery.ts` | the plugin's TypeScript side (`registerPlugin('PlaypexDiscovery')`), `toUrl` (no scheme = http, no port = 28470, IPv6 literals), a browser fallback for development (no discovery) |
| `src/style.css` | the dashboard's true-black flat look (Jost, white primary, gold for what's live) |
| `capacitor.config.json` | `appId` `app.playpex.manager`, `appendUserAgent` `PlaypexManager/0.1`, `server.allowNavigation` `["*"]` (any server the user picks loads in the WebView; Capacitor's bridge is then exposed to it: its plugins are discovery and connection), `androidScheme` https |
| `android/.../AppChrome.java` | what a browser does and Capacitor's WebView doesn't. **Full screen**: a page's `requestFullscreen()` shows its element over everything (`onShowCustomView`; Capacitor's `BridgeWebChromeClient` refuses it), hides the system bars (swipe shows them briefly) and turns to landscape, restored on leaving. **Back**: leaves full screen, else closes the page's open dialog / sheet / menu (an Escape keydown, when one with role dialog, alertdialog, menu or listbox is open), else `goBack()`, else the app goes to the background |
| `android/.../PullToReload.java` | swipe down from the top reloads the page shown (the picker or a dashboard): the WebView wrapped in AndroidX `SwipeRefreshLayout` (gold spinner). A script added on every page load reports on each touch (`window.PlaypexPull.set`) whether the touch starts at the page's top, outside any scrolled list and with no dialog or sheet open; only then can a pull reload |
| `android/` | generated by `npx cap add android`, then edited: `MainActivity` registers the plugin and attaches `PullToReload` and `AppChrome` (dependency `androidx.swiperefreshlayout` in `app/build.gradle`); the manifest has `usesCleartextTraffic` (servers speak plain HTTP) and the network permissions (network / Wi-Fi state, multicast); the icon is the Playpex mark as a vector (`res/drawable/ic_launcher_foreground.xml`, monochrome for themed icons; the PNG `mipmap-*/ic_launcher*.png` used before Android 8 are still Capacitor's); the launch screen: see the Splash row |
| Splash | Android 12+: the system launch screen animates the mark in (`res/drawable/splash_mark.xml`, an animated vector: grows from 80 %, fades in; theme in `res/values-v31/styles.xml`; older Android: the static mark, `values/styles.xml`). `MainActivity` (`installSplashScreen`) holds it until the page calls `PlaypexSplash.ready()` (`PlaypexSplash.java`, sent by `src/main.ts` after its first frame, or 150 ms) or 2.5 s, then fades it out as the mark grows 8 %. While the last server opens, the page shows its own splash (`.splash` in `src/style.css`): the same mark at the same place (centred, 150 px), with a gold sheen, "Playpex", "Opening <server>…" and a running gold line, until the dashboard loads |

## Commands (repo root)
| Goal | Command |
|---|---|
| The picker in a browser (layout only: no discovery there) | `npm run manager` (Vite) |
| Build the picker and copy it into `android/` | `npm run build:manager` (`vite build` + `cap sync android`) |
| Debug APK | `JAVA_HOME=~/.local/jdk-21 npm run apk:manager` → `apps/manager/android/app/build/outputs/apk/debug/app-debug.apk` (~4 MB). Needs **JDK 21** (Capacitor 8) and the Android SDK (platform 36, build-tools 35.0.0); `android/local.properties` (git-ignored) holds `sdk.dir`. On the dev machine: JDK 21 in `~/.local/jdk-21`, the SDK in `~/Android/Sdk` (installed 2026-10-26 without root); the Gradle wrapper uses the `-bin` distribution |
| Install on a phone | USB debugging on, then `~/Android/Sdk/platform-tools/adb install -r apps/manager/android/app/build/outputs/apk/debug/app-debug.apk`; or copy the APK to the phone and open it (allow installs from that app) |
| Android Studio | `npm run open -w apps/manager` |

After editing `src/`, run `build:manager` before building in Android Studio: the APK ships `android/app/src/main/assets/public` (git-ignored), not `src/`.
