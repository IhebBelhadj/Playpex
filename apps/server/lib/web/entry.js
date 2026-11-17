'use strict';

// /app/: one address for Playpex on the web (docs/web-unified-plan.md §4). A
// page of its own whose script opens the client for this device: Playpex TV
// (/tv/) on a TV's browser, Playpex Mobile (/m/) on a phone, the admin's
// choice (clients.computers / clients.tablets, from GET /api/v1/clients) on a
// computer or a tablet; ?view=tv|mobile chooses and is remembered by this
// browser (?view=auto forgets it); ?at=<place> opens that place there (the
// clients' "Switch view"). Only the browser knows whether it has a mouse, so
// this can't be a redirect. Nothing from the request is written into the page.
// The script is ES5 (XMLHttpRequest, no arrow functions): TVs' browsers are old.

var crypto = require('crypto');

// Places both clients have, and where each keeps them (§5)
var PLACES = {
  tv: {
    home: 'home/list', movies: 'movies/list', shows: 'shows/list', search: 'search', mylist: 'watchlist',
    settings: 'settings', movie: 'movies/movie/', show: 'shows/show/', person: 'people/'
  },
  mobile: {
    home: '', movies: 'movies', shows: 'shows', search: 'search', mylist: 'mylist',
    settings: 'settings', movie: 'title/movie/', show: 'title/tv/', person: 'person/'
  }
};

var SCRIPT = [
  '(function () {',
  '  var KEY = "playpex.web.view";',
  '  var PLACES = ' + JSON.stringify(PLACES) + ';',
  '  var TV = /SmartTV|SMART-TV|Tizen|Web0S|WebOS|HbbTV|NetCast|BRAVIA|AFT[A-Z]|CrKey|Android ?TV|Google ?TV|Roku|PhilipsTV|VIDAA|Hisense|Xbox|PlayStation|Nintendo|Viera|AQUOS|SmartHub|TV Safari|Large Screen/i;',
  '  function param(name) {',
  '    var m = new RegExp("[?&]" + name + "=([^&#]*)").exec(location.search);',
  '    if (!m) return null;',
  '    try { return decodeURIComponent(m[1].replace(/\\+/g, " ")); } catch (e) { return null; }',
  '  }',
  '  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }',
  '  function store(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) {} }',
  '  function media(q) { return !!(window.matchMedia && window.matchMedia(q).matches); }',
  // tv, phone, tablet or computer
  '  function device() {',
  '    if (TV.test(navigator.userAgent)) return "tv";',
  '    var touchOnly = media("(pointer: coarse)") && !media("(any-pointer: fine)");',
  '    if (!touchOnly) return "computer";',
  '    return Math.min(screen.width, screen.height) >= 600 ? "tablet" : "phone";',
  '  }',
  // ?at=title/movie/603 → the client's own path
  '  function place(view, at) {',
  '    var p = PLACES[view], m;',
  '    if (!at) return "";',
  '    if ((m = /^title\\/(movie|tv)\\/(\\d+)$/.exec(at))) return p[m[1] == "movie" ? "movie" : "show"] + m[2];',
  '    if ((m = /^person\\/(\\d+)$/.exec(at))) return p.person + m[1];',
  '    return Object.prototype.hasOwnProperty.call(p, at) && !/^(movie|show|person)$/.test(at) ? p[at] : "";',
  '  }',
  '  function show(id) {',
  '    var el = document.getElementById(id);',
  '    if (el) el.style.display = "block";',
  '    var wait = document.getElementById("wait");',
  '    if (wait) wait.style.display = "none";',
  '  }',
  '  var asked = param("view");',
  '  if (asked == "auto") store(null);',
  '  else if (asked == "tv" || asked == "mobile") store(asked);',
  '  else asked = null;',
  '  var chosen = asked || stored();',
  '  if (chosen != "tv" && chosen != "mobile") chosen = null;',
  '  var kind = device();',
  '  function decide(info) {',
  '    var open = (info && info.open) || { computers: "tv", tablets: "mobile" };',
  '    var want = chosen || (kind == "tv" ? "tv" : kind == "phone" ? "mobile" : kind == "tablet" ? open.tablets : open.computers);',
  '    var other = want == "tv" ? "mobile" : "tv";',
  '    var usable = {}, paths = { tv: "/tv/", mobile: "/m/" };',
  '    if (info && info.web) {',
  '      for (var i = 0; i < info.web.length; i++) {',
  '        var c = info.web[i];',
  '        usable[c.id] = c.enabled && c.built;',
  '        paths[c.id] = c.path;',
  '      }',
  '    } else {',
  '      usable.tv = usable.mobile = true;',
  '    }',
  '    var view = usable[want] ? want : usable[other] ? other : null;',
  '    if (!view) return show("none");',
  '    location.replace(paths[view] + place(view, param("at")));',
  '  }',
  '  var xhr = new XMLHttpRequest();',
  '  xhr.open("GET", "/api/v1/clients");',
  '  xhr.timeout = 8000;',
  '  xhr.onload = function () {',
  '    var info = null;',
  '    try { info = JSON.parse(xhr.responseText); } catch (e) {}',
  '    decide(xhr.status == 200 ? info : null);',
  '  };',
  '  xhr.onerror = xhr.ontimeout = function () { decide(null); };',
  '  xhr.send();',
  '})();'
].join('\n');

var STYLE = [
  ':root { color-scheme: dark; }',
  'html, body { margin: 0; height: 100%; background: #000; color: #f2efe9; }',
  'body { display: flex; align-items: center; justify-content: center; text-align: center;',
  '  font: 16px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 0 16px; box-sizing: border-box; }',
  'h1 { font-size: 22px; margin: 0 0 8px; }',
  'p { margin: 0 0 16px; color: #b9b3a8; }',
  'a { color: #e9cf8a; }',
  '.links a { display: inline-block; margin: 0 8px; }',
  '#none { display: none; }'
].join('\n');

function hash(text) {
  return "'sha256-" + crypto.createHash('sha256').update(text).digest('base64') + "'";
}

var CSP = "default-src 'none'; script-src " + hash(SCRIPT) + "; style-src " + hash(STYLE) +
  "; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function document(title, body, script) {
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="theme-color" content="#000000">\n<title>' + title + '</title>\n' +
    '<style>' + STYLE + '</style>\n</head>\n<body>\n' + body + '\n' +
    (script ? '<script>' + script + '</script>\n' : '') + '</body>\n</html>\n';
}

var PAGE = document('Playpex',
  '<main>\n' +
  '<div id="wait"><h1>Playpex</h1><p>Opening…</p></div>\n' +
  '<div id="none"><h1>Playpex isn’t available in a browser here</h1>' +
  '<p>The admin turned the web clients off on this server, or they aren’t built yet.</p></div>\n' +
  '<noscript><p class="links"><a href="/tv/">Playpex TV</a><a href="/m/">Playpex Mobile</a></p></noscript>\n' +
  '</main>', SCRIPT);

// /app/
function send(res) {
  res.set('Cache-Control', 'no-cache');
  res.set('Content-Security-Policy', CSP);
  res.set('Referrer-Policy', 'no-referrer');
  res.type('html').send(PAGE);
}

// /tv/ or /m/ while the admin turned it off: 403 and the way to the other
var OFF_CSP = "default-src 'none'; style-src " + hash(STYLE) + "; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function off(res, client) {
  res.status(403);
  res.set('Cache-Control', 'no-cache');
  res.set('Content-Security-Policy', OFF_CSP);
  res.type('html').send(document(client.name,
    '<main><h1>' + client.name + ' is turned off on this server</h1>' +
    '<p>The admin can turn it on again in the dashboard, under Clients.</p>' +
    '<p><a href="/app/">Open Playpex</a></p></main>'));
}

module.exports = { send: send, off: off, PLACES: PLACES };
