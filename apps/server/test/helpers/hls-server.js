'use strict';

// A throwaway Playpex server with the made-up HLS web of ./hls-web.js and a
// plugin playing it (docs/providers-plan.md step 8), for the TV's scenario
// apps/tv/scripts/scenarios/live.js. Its state lives in a temp folder; a
// profile "Tester" exists. Stops on Ctrl+C.
//   node apps/server/test/helpers/hls-server.js [--port 28490]
// Prints the server's URL, then one line per stream: `<name> <ref> <format>`.

var fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-hls-server-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';
process.env.PLAYPEX_LAN_SHARING = '0';

var server = require('../..'),
  plugins = require('../../lib/plugins'),
  hlsWeb = require('./hls-web');

var portArg = process.argv.indexOf('--port'),
  PORT = portArg !== -1 ? parseInt(process.argv[portArg + 1], 10) : 28490;

var CODE = String.raw`
var WEB = 'https://web.playpex-test.dev:PORT', AUTH = { Authorization: 'Bearer hls-token' };
function play(title, source) {
  return { data: null, effects: [{ type: 'play', request: { title: title, sources: [Object.assign({ headers: AUTH }, source)], tracking: 'none' } }] };
}
playpex.data('vod', function () { return play('Test VOD', { kind: 'hls', url: WEB + '/vod/master.m3u8', label: 'Test VOD' }); });
playpex.data('liveHls', function () { return play('Test News', { kind: 'live', url: WEB + '/live/index.m3u8', label: 'Test News' }); });
playpex.data('live', function () { return play('Test TV', { kind: 'live', url: WEB + '/tv/stream.ts', label: 'Test TV' }); });
`;

function post(apiPath, body) {
  return new Promise(function (resolve, reject) {
    var payload = Buffer.from(JSON.stringify(body));
    var req = http.request('http://127.0.0.1:' + PORT + '/api/v1' + apiPath, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Playpex-Device': 'hls-server' }
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

hlsWeb.start().then(function (web) {
  if (!web) {
    throw new Error('openssl and ffmpeg are needed');
  }
  var dir = path.join(tmp, 'plugins', 'streamer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify({
    id: 'streamer', name: 'Streamer', version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1' }, audience: 'everyone',
    permissions: { network: web.hosts, play: true, sources: ['hls', 'live'] }
  }));
  fs.writeFileSync(path.join(dir, 'server.js'), CODE.replace(/PORT/g, String(web.port)));
  process.on('SIGINT', function () {
    server.stop().then(function () { return web.stop(); }).then(function () {
      fs.rmSync(tmp, { recursive: true, force: true });
      process.exit(0);
    });
  });
  return server.start({ port: PORT, console: false, library: false, torrents: { engine: 'fake', discovery: false },
    plugins: { dirs: [dir], http: web.http() } });
}).then(function (info) {
  console.log('http://127.0.0.1:' + info.port);
  return new Promise(function (resolve) {
    (function wait() {
      var p = plugins.get('streamer');
      return p && p.state === 'enabled' ? resolve() : setTimeout(wait, 100);
    })();
  });
}).then(function () {
  return post('/profiles', { name: 'Tester' });
}).then(function () {
  return Promise.all(['vod', 'liveHls', 'live'].map(function (name) {
    return post('/plugins/streamer/data/' + name, { args: {} }).then(function (r) {
      var src = r.effects[0].request.sources[0];
      console.log(name + ' ' + src.ref + ' ' + src.format);
    });
  }));
}).catch(function (err) {
  console.error(err.message);
  process.exit(1);
});
