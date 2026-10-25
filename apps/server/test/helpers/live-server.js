'use strict';

// A throwaway Playpex server with the plugin plugins/m3u set to the made-up
// IPTV provider of ./live-web.js (docs/providers-plan.md step 9), for the
// TV's scenario apps/tv/scripts/scenarios/guide.js. Its state lives in a temp
// folder; a profile "Tester" exists. Stops on Ctrl+C.
//   node apps/server/test/helpers/live-server.js [--port 28491] [--channels 300]
// Prints the server's URL once the channels and the guide are loaded.

var fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-live-server-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';
process.env.PLAYPEX_LAN_SHARING = '0';

var server = require('../..'),
  plugins = require('../../lib/plugins'),
  pluginSettings = require('../../lib/plugins/settings'),
  liveWeb = require('./live-web');

function arg(name, fallback) {
  var i = process.argv.indexOf('--' + name);
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : fallback;
}

var PORT = arg('port', 28491),
  M3U = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'm3u');

function request(method, apiPath, body) {
  return new Promise(function (resolve, reject) {
    var payload = body ? Buffer.from(JSON.stringify(body)) : null;
    var req = http.request('http://127.0.0.1:' + PORT + '/api/v1' + apiPath, {
      method: method, headers: Object.assign({ 'X-Playpex-Device': 'live-server' }, payload ? { 'Content-Type': 'application/json' } : {})
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

var web;
liveWeb.start({ channels: arg('channels', 300), days: 2 }).then(function (w) {
  web = w;
  if (!web) {
    throw new Error('openssl is needed');
  }
  process.on('SIGINT', function () {
    server.stop().then(function () { return web.stop(); }).then(function () {
      fs.rmSync(tmp, { recursive: true, force: true });
      process.exit(0);
    });
  });
  return server.start({ port: PORT, console: false, library: false, torrents: { engine: 'fake', discovery: false },
    plugins: { dirs: [M3U], http: web.http(), repositories: false } });
}).then(function (info) {
  return new Promise(function (resolve) {
    (function wait() {
      var p = plugins.get('m3u');
      return p && p.state === 'enabled' ? resolve(info) : setTimeout(wait, 100);
    })();
  });
}).then(function (info) {
  return pluginSettings.update('m3u', { values: { playlist: web.playlist, guide: web.guide } }).then(function () { return info; });
}).then(function (info) {
  return request('POST', '/profiles', { name: 'Tester' }).then(function () {
    return request('GET', '/live/m3u/channels');
  }).then(function (r) {
    var ids = r.channels.slice(0, 10).map(function (c) { return c.id; }).join(','),
      from = new Date(Math.floor(Date.now() / 1800000) * 1800000);
    return request('GET', '/live/m3u/guide?channels=' + ids + '&from=' + from.toISOString() + '&to=' + new Date(from.getTime() + 3 * 3600000).toISOString());
  }).then(function () {
    console.log('http://127.0.0.1:' + info.port + (web.streams ? '' : '  (no ffmpeg: channels don\'t play)'));
  });
}).catch(function (err) {
  console.error(err.message);
  process.exit(1);
});
