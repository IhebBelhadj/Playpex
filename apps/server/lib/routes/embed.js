'use strict';

// GET /api/v1/embed/youtube?v=<id>&start=<s>&cc=<lang>&hl=<lang>: the page a
// client frames to play a plugin's `embed` source (provider youtube) in
// YouTube's own IFrame player (docs/api/plugins.md, "Embedded videos").
//
// Why a page of the server: YouTube's embeds refuse to play without a
// referring page (error 153), and the TV app is a file:// document, which
// sends none. Framed from the server, YouTube sees the server's address as
// the page it is embedded in. The page is static (nothing from the request
// is written into it; it reads its query itself and checks it), holds no data
// or token, and is public like GET /server: the TV's shell sends its token
// only to its own top frame (apps/tv/electron/auth.js), never from a frame.
//
// The player comes from youtube-nocookie.com (no cookies until it plays),
// without YouTube's controls: the client draws its own and drives the player
// through postMessage (window.parent only):
//   client → page  { playpex: 'embed', cmd: 'play' | 'pause' | 'seek' (t) | 'volume' (volume 0–100, muted) | 'rate' (rate) }
//   page → client  { playpex: 'embed', type: 'ready' }
//                  { playpex: 'embed', type: 'state', state: unstarted|ended|playing|paused|buffering|cued,
//                    time, duration, loaded (0–1), rate }  on every change and every 250 ms
//                  { playpex: 'embed', type: 'error', code }  YouTube's: 2 bad id, 5 HTML5, 100 gone or private,
//                    101 / 150 the owner doesn't allow embedding, 153 no referrer

var crypto = require('crypto'),
  express = require('express'),
  router = express.Router();

var SCRIPT = [
  '(function () {',
  '  var q = new URLSearchParams(location.search);',
  '  var id = q.get("v") || "";',
  '  var start = Math.max(0, Math.floor(Number(q.get("start")) || 0));',
  '  var lang = /^[a-z]{2}(-[A-Z]{2})?$/.test(q.get("hl") || "") ? q.get("hl") : "en";',
  '  var cc = /^[a-z]{2}$/.test(q.get("cc") || "") ? q.get("cc") : "";',
  '  var player = null, timer = null;',
  '  var STATES = { "-1": "unstarted", "0": "ended", "1": "playing", "2": "paused", "3": "buffering", "5": "cued" };',
  '  function send(msg) { msg.playpex = "embed"; if (window.parent !== window) window.parent.postMessage(msg, "*"); }',
  '  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) { send({ type: "error", code: 2 }); return; }',
  '  function report() {',
  '    if (!player || !player.getPlayerState) return;',
  '    send({ type: "state", state: STATES[String(player.getPlayerState())] || "unstarted",',
  '      time: player.getCurrentTime() || 0, duration: player.getDuration() || 0,',
  '      loaded: player.getVideoLoadedFraction() || 0, rate: player.getPlaybackRate() || 1 });',
  '  }',
  '  window.onYouTubeIframeAPIReady = function () {',
  '    var vars = { autoplay: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, playsinline: 1, rel: 0,',
  '      start: start, hl: lang, origin: location.origin, enablejsapi: 1 };',
  '    if (cc) { vars.cc_load_policy = 1; vars.cc_lang_pref = cc; }',
  '    player = new YT.Player("player", { host: "https://www.youtube-nocookie.com", videoId: id, width: "100%", height: "100%",',
  '      playerVars: vars,',
  '      events: {',
  '        onReady: function () { send({ type: "ready" }); report(); timer = setInterval(report, 250); },',
  '        onStateChange: report,',
  '        onPlaybackRateChange: report,',
  '        onError: function (e) { send({ type: "error", code: e.data }); }',
  '      } });',
  '  };',
  '  window.addEventListener("message", function (e) {',
  '    var m = e.data;',
  '    if (e.source !== window.parent || !m || m.playpex !== "embed" || !player || !player.playVideo) return;',
  '    if (m.cmd === "play") player.playVideo();',
  '    else if (m.cmd === "pause") player.pauseVideo();',
  '    else if (m.cmd === "seek" && isFinite(m.t)) player.seekTo(Math.max(0, Number(m.t)), true);',
  '    else if (m.cmd === "volume") { player.setVolume(Math.max(0, Math.min(100, Number(m.volume) || 0))); if (m.muted) player.mute(); else player.unMute(); }',
  '    else if (m.cmd === "rate" && isFinite(m.rate)) player.setPlaybackRate(Number(m.rate));',
  '    report();',
  '  });',
  '  var s = document.createElement("script");',
  '  s.src = "https://www.youtube.com/iframe_api";',
  '  document.head.appendChild(s);',
  '})();'
].join('\n');

var PAGE = '<!doctype html>\n<html><head><meta charset="utf-8"><meta name="referrer" content="strict-origin-when-cross-origin">' +
  '<title>Playpex</title><style>html,body,#player{margin:0;width:100%;height:100%;background:#000;overflow:hidden}</style>' +
  '</head><body><div id="player"></div><script>' + SCRIPT + '</script></body></html>\n';

var HASH = crypto.createHash('sha256').update(SCRIPT).digest('base64');

// only this page's own script and YouTube's (its API loader, then its widget code)
var CSP = [
  "default-src 'none'",
  "script-src 'sha256-" + HASH + "' https://www.youtube.com https://s.ytimg.com",
  'frame-src https://www.youtube-nocookie.com https://www.youtube.com',
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

router.get('/youtube', function (req, res) {
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': CSP,
    // YouTube needs the page's origin as the referrer; the path and query stay here
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache'
  });
  res.send(PAGE);
});

module.exports = router;
