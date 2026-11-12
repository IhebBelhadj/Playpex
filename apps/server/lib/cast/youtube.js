'use strict';

// Playpex screens in the YouTube app's Cast list (docs/cast-plan.md §6, step 5):
// a DIAL / Lounge receiver per screen (yt-cast-receiver, pinned: YouTube's
// protocol is unofficial), named "Playpex – <screen>". What a phone casts
// becomes a cast to that screen (lib/cast: an `embed` source the core's
// /embed/youtube page plays, nothing saved for it); YouTube's remote (play,
// pause, seek, volume, stop, Up next) drives that cast, and the screen's state
// goes back to the phone.
//
// On while `cast.youtube` and `cast.enabled` are on and the server is on the
// LAN (not recovery mode). A screen counts while its events socket takes casts
// of embeds; a screen that went away keeps its receiver GRACE_MS (a TV app that
// restarts doesn't leave the Cast list). DIAL listens from 28473 (one port per
// screen, MAX_SCREENS at most) on the machine's LAN interfaces only (Docker and
// VPN bridges would be advertised otherwise). Each receiver keeps its identity
// in <config>/youtube-cast.json, so phones find the same TV after a restart.
//
//   start(info, { lan })  refresh()  stop()      the server's lifecycle (index.js, Settings)
//   status() → [{ deviceId, name, port, senders }]
//   code(deviceId) → Promise<string|null>        "Link with TV code" for that screen
//   playerFor(deviceId) → Promise<ScreenPlayer>   tests: the player without a receiver

var fs = require('fs'),
  os = require('os'),
  dgram = require('dgram'),
  httpGet = require('http').get,
  path = require('path'),
  events = require('../events'),
  settings = require('../settings'),
  paths = require('../paths'),
  inspect = require('../links/inspect'),
  log = require('../logger').child('cast');

var BASE_PORT = 28473,
  MAX_SCREENS = 8,
  GRACE_MS = 60 * 1000,
  CODE_WAIT_MS = 15 * 1000,
  // end of a video: closer than this to its end counts as finished (Up next plays)
  END_SLACK_S = 3,
  // a stop waits this long for a play that follows it (YouTube's far seeks are stop + play)
  STOP_HOLD_MS = 1500,
  // the library announces a receiver once, at its start; phones that search little (one sharing its
  // hotspot, whose searches leave on mobile data) only learn of it from announcements: again this often
  ANNOUNCE_MS = 30 * 1000,
  SSDP_ADDRESS = '239.255.255.250',
  SSDP_PORT = 1900,
  DIAL_TYPES = ['urn:dial-multiscreen-org:service:dial:1', 'urn:dial-multiscreen-org:device:dial:1', 'upnp:rootdevice'];

var lib = null,            // the module (ESM), loaded once
  classes = null,
  running = new Map(),     // deviceId → { receiver, player, port, name, pairing, code, leaving }
  started = false,
  lan = false,
  listening = false,
  pending = Promise.resolve();

function cast() {
  return require('./index');
}

function load() {
  if (lib) {
    return Promise.resolve(lib);
  }
  return import('yt-cast-receiver').then(function (m) {
    lib = m;
    return m;
  });
}

// ── what the receivers store ────────────────────────────────────────────────

var STORE = function () { return path.join(paths.config, 'youtube-cast.json'); };

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE(), 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function writeStore(all) {
  try {
    fs.writeFileSync(STORE(), JSON.stringify(all, null, 2));
  } catch (e) {
    log.warn('youtube: could not save ' + STORE() + ': ' + e.message);
  }
}

// ── the library's classes, made once it's loaded ────────────────────────────

function makeClasses(m) {
  var S = m.PLAYER_STATUSES;

  // Its identity per screen (app.pid, mdxContext), in one file
  class ScreenStore extends m.DataStore {
    constructor(deviceId) {
      super();
      this.deviceId = deviceId;
    }
    async set(key, value) {
      var all = readStore();
      all[this.deviceId] = Object.assign(all[this.deviceId] || {}, { [key]: value });
      writeStore(all);
    }
    async get(key) {
      var mine = readStore()[this.deviceId];
      return mine && mine[key] !== undefined ? mine[key] : null;
    }
  }

  // Its log lines in the server's log
  class ServerLogger {
    constructor() { this.level = 'warn'; }
    line(level, msg) {
      var text = msg.map(function (x) { return x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x); }).join(' ');
      log[level]('youtube: ' + text.slice(0, 500));
    }
    error() { this.line('error', [].slice.call(arguments)); }
    warn() { this.line('warn', [].slice.call(arguments)); }
    info() { this.line('info', [].slice.call(arguments)); }
    debug() { this.line('debug', [].slice.call(arguments)); }
    setLevel(value) { this.level = value; }
  }

  // The player of one screen: YouTube's commands become that screen's cast
  class ScreenPlayer extends m.Player {
    constructor(deviceId) {
      super();
      this.deviceId = deviceId;
      this.castId = null;
      this.videoId = null;
      this.stopping = null;
      this.sender = null;
      this.at = { positionS: 0, durationS: 0, paused: true, time: Date.now() };
      this.level = null;
    }

    from() {
      var who = this.sender && (this.sender.user && this.sender.user.name || this.sender.name);
      return { deviceId: 'youtube:' + this.deviceId, name: who ? 'YouTube · ' + who : 'YouTube' };
    }

    command(action, extra) {
      if (!this.castId) {
        return false;
      }
      try {
        cast().command(null, this.castId, Object.assign({ action: action }, extra), { from: this.from() });
        return true;
      } catch (e) {
        log.debug('youtube: ' + action + ' not delivered: ' + e.message);
        return false;
      }
    }

    async doPlay(video, position) {
      // YouTube sends stop then play for a seek it can't do in place, and play again for the video
      // playing: the same video is a seek (no new player), a stop just before a play never closes it
      clearTimeout(this.stopping);
      this.stopping = null;
      if (this.castId && this.videoId === video.id) {
        var at = position > 0 ? position : 0;
        if (this.command('seek', { positionS: at })) {
          this.command('resume');
          this.settle({ positionS: at, paused: false });
          return true;
        }
      }
      var info = await Promise.race([
        inspect.youtubeInfo(video.id),
        new Promise(function (resolve) { setTimeout(function () { resolve({}); }, 3000); })
      ]);
      try {
        var answer = await cast().play(null, this.deviceId, {
          title: info.title || 'YouTube video',
          subtitle: info.author,
          image: 'https://i.ytimg.com/vi/' + video.id + '/hqdefault.jpg',
          source: { embed: { provider: 'youtube', id: video.id } },
          positionS: position > 0 ? position : undefined,
          // YouTube keeps its own history; Playpex saves nothing for it
          tracking: 'none'
        }, { from: this.from() });
        this.castId = answer.castId;
        this.videoId = video.id;
        this.at = { positionS: position || 0, durationS: 0, paused: false, time: Date.now() };
        log.info('youtube: ' + this.from().name + ' cast ' + video.id + ' to ' + this.deviceId);
        return true;
      } catch (e) {
        log.warn('youtube: cast to ' + this.deviceId + ' refused: ' + e.message);
        return false;
      }
    }

    async doPause() {
      var ok = this.command('pause');
      if (ok) { this.settle({ paused: true }); }
      return ok;
    }

    async doResume() {
      var ok = this.command('resume');
      if (ok) { this.settle({ paused: false }); }
      return ok;
    }

    async doSeek(position) {
      var ok = this.command('seek', { positionS: Math.max(0, position) });
      if (ok) { this.settle({ positionS: Math.max(0, position) }); }
      return ok;
    }

    async doStop() {
      // held back a moment: a play right after it (another video, a far seek) takes the screen instead
      clearTimeout(this.stopping);
      this.at = Object.assign({}, this.at, { paused: true, time: Date.now() });
      this.stopping = setTimeout(function () {
        this.stopping = null;
        this.command('stop');
        this.castId = null;
        this.videoId = null;
        this.at = { positionS: 0, durationS: 0, paused: true, time: Date.now() };
      }.bind(this), STOP_HOLD_MS);
      return true;
    }

    // YouTube's volume is this screen's Playpex volume (the device setting player.volume)
    async doSetVolume(volume) {
      var level = Math.max(0, Math.min(100, Math.round(volume.level)));
      this.level = level;
      return require('../userData').services().then(function (s) {
        return s.settings.updateDevice(this.deviceId, { 'player.volume': level });
      }.bind(this)).then(function () { return true; }, function (e) {
        log.debug('youtube: volume not set: ' + e.message);
        return false;
      });
    }

    async doGetVolume() {
      if (this.level === null) {
        var device = await require('../userData').services().then(function (s) {
          return s.settings.device(this.deviceId);
        }.bind(this)).catch(function () { return {}; });
        var v = Number(device && device['player.volume']);
        this.level = isFinite(v) ? v : 100;
      }
      return { level: this.level, muted: false };
    }

    async doGetPosition() {
      var a = this.at, s = a.positionS + (a.paused ? 0 : (Date.now() - a.time) / 1000);
      return a.durationS > 0 ? Math.min(a.durationS, s) : s;
    }

    async doGetDuration() {
      return this.at.durationS || 0;
    }

    settle(fields) {
      var now = Date.now(), a = this.at;
      var position = a.positionS + (a.paused ? 0 : (now - a.time) / 1000);
      this.at = Object.assign({}, a, { positionS: position, time: now }, fields);
    }

    /** cast.updated / cast.ended of this player's cast: what the phone shows follows the screen */
    onCast(topic, c) {
      if (!c || c.castId !== this.castId) {
        return;
      }
      var was = this.at.paused;
      this.at = {
        positionS: typeof c.positionS === 'number' ? c.positionS : this.at.positionS,
        durationS: typeof c.durationS === 'number' ? c.durationS : this.at.durationS,
        paused: c.state !== 'playing',
        time: Date.now()
      };
      if (topic === 'cast.ended' || c.state === 'ended' || c.state === 'failed') {
        this.castId = null;
        this.videoId = null;
        var d = this.at.durationS;
        // the video got to its end: Up next plays; else it was stopped on the screen (or replaced)
        if (c.state !== 'failed' && d > 0 && this.at.positionS >= d - END_SLACK_S) {
          return this.pause().then(function () { return this.next(); }.bind(this)).catch(function () {});
        }
        return this.notifyExternalStateChange(S.STOPPED).catch(function () {});
      }
      if (c.state === 'playing' || c.state === 'paused') {
        // the screen's own remote, or the state reported back after our command
        if (was !== this.at.paused || this.status !== (this.at.paused ? S.PAUSED : S.PLAYING)) {
          return this.notifyExternalStateChange(this.at.paused ? S.PAUSED : S.PLAYING).catch(function () {});
        }
        return this.notifyExternalStateChange().catch(function () {});
      }
    }
  }

  return { ScreenStore: ScreenStore, ServerLogger: ServerLogger, ScreenPlayer: ScreenPlayer };
}

function ready() {
  return load().then(function (m) {
    if (!classes) {
      classes = makeClasses(m);
    }
    return { m: m, c: classes };
  });
}

// ── which interfaces DIAL announces on ───────────────────────────────────────

var VIRTUAL = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|incus|lxc|lxd|tun|tap|utun|wg|zt|tailscale|cni|flannel|kube|podman)/i;

/** The machine's LAN interfaces (IPv4, not loopback, not a container or VPN bridge) */
function lanInterfaces() {
  var all = os.networkInterfaces(), names = [];
  Object.keys(all).forEach(function (name) {
    if (VIRTUAL.test(name)) {
      return;
    }
    if ((all[name] || []).some(function (a) { return (a.family === 'IPv4' || a.family === 4) && !a.internal; })) {
      names.push(name);
    }
  });
  return names;
}

// ── announcements ────────────────────────────────────────────────────────────

/** The LAN interfaces' IPv4 addresses */
function lanAddresses() {
  var all = os.networkInterfaces(), out = [];
  lanInterfaces().forEach(function (name) {
    (all[name] || []).forEach(function (a) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) {
        out.push(a.address);
      }
    });
  });
  return out;
}

// The receiver's UDN, from its own device description (what its first announcement said)
function udnOf(port) {
  return new Promise(function (resolve) {
    var req = httpGet({ host: '127.0.0.1', port: port, path: '/ytcr/ssdp/device-desc.xml', timeout: 3000 }, function (res) {
      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        var m = /<UDN>\s*uuid:([^<\s]+)\s*<\/UDN>/i.exec(body);
        resolve(m ? m[1] : null);
      });
    });
    req.on('error', function () { resolve(null); });
    req.on('timeout', function () { req.destroy(); resolve(null); });
  });
}

/** ssdp:alive for a receiver on every LAN address, now and every ANNOUNCE_MS; → stop() */
function announce(port) {
  var sockets = {}, timer = null, stopped = false, server = os.type() + '/' + os.release() + ' UPnP/1.1 Playpex';
  function socketFor(address) {
    if (sockets[address]) {
      return sockets[address];
    }
    var socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', function () {
      try { socket.close(); } catch (e) { /* closed */ }
      delete sockets[address];
    });
    socket.bind(0, address, function () {
      try { socket.setMulticastInterface(address); socket.setMulticastTTL(2); } catch (e) { /* kept as is */ }
    });
    return (sockets[address] = socket);
  }
  function send(udn) {
    if (stopped) {
      return;
    }
    lanAddresses().forEach(function (address) {
      var socket = socketFor(address);
      DIAL_TYPES.concat('uuid:' + udn).forEach(function (nt) {
        var message = Buffer.from([
          'NOTIFY * HTTP/1.1',
          'HOST: ' + SSDP_ADDRESS + ':' + SSDP_PORT,
          'CACHE-CONTROL: max-age=1800',
          'LOCATION: http://' + address + ':' + port + '/ytcr/ssdp/device-desc.xml',
          'NT: ' + nt,
          'NTS: ssdp:alive',
          'SERVER: ' + server,
          'USN: uuid:' + udn + (nt.indexOf('uuid:') === 0 ? '' : '::' + nt),
          '', ''
        ].join('\r\n'));
        socket.send(message, SSDP_PORT, SSDP_ADDRESS, function () {});
      });
    });
  }
  udnOf(port).then(function (udn) {
    if (!udn || stopped) {
      return;
    }
    send(udn);
    timer = setInterval(function () { send(udn); }, ANNOUNCE_MS);
    if (timer.unref) {
      timer.unref();
    }
  });
  return function stop() {
    stopped = true;
    clearInterval(timer);
    Object.keys(sockets).forEach(function (a) {
      try { sockets[a].close(); } catch (e) { /* closed */ }
    });
    sockets = {};
  };
}

// ── receivers ────────────────────────────────────────────────────────────────

function wanted() {
  return started && lan && !!settings.get('cast.youtube') && !!settings.get('cast.enabled');
}

function takesEmbeds(deviceId) {
  var control = events.deviceControl(deviceId);
  return control.online && control.cast && control.accepts.indexOf('embed') >= 0;
}

function freePort() {
  var used = [];
  running.forEach(function (r) { used.push(r.port); });
  for (var p = BASE_PORT; p < BASE_PORT + MAX_SCREENS * 4; p++) {
    if (used.indexOf(p) < 0) {
      return p;
    }
  }
  return null;
}

// One at a time: starts and stops of receivers never overlap
function serial(work) {
  pending = pending.then(work, work).catch(function (e) {
    log.warn('youtube: ' + e.message);
  });
  return pending;
}

function ensure(deviceId) {
  return serial(function () {
    var r = running.get(deviceId);
    if (r) {
      clearTimeout(r.leaving);
      r.leaving = null;
      return null;
    }
    if (!wanted() || !takesEmbeds(deviceId)) {
      return null;
    }
    if (running.size >= MAX_SCREENS) {
      log.warn('youtube: ' + MAX_SCREENS + ' screens in the Cast list already; ' + deviceId + ' left out');
      return null;
    }
    return Promise.all([ready(), cast().screenName(deviceId)]).then(function (x) {
      return startOne(x[0], deviceId, 'Playpex - ' + x[1], 0);
    });
  });
}

function startOne(k, deviceId, name, tries) {
  var port = freePort();
  if (port === null) {
    return null;
  }
  var player = new k.c.ScreenPlayer(deviceId),
    interfaces = lanInterfaces(),
    receiver = new k.m.default(player, {
      device: { name: name, screenName: name, brand: 'Playpex', model: 'Playpex TV' },
      dial: Object.assign({ port: port }, interfaces.length ? { bindToInterfaces: interfaces } : {}),
      dataStore: new k.c.ScreenStore(deviceId),
      logger: new k.c.ServerLogger(),
      // the library's own lines follow the server's log level
      logLevel: settings.get('general.logLevel') === 'debug' ? k.m.LOG_LEVELS.DEBUG : k.m.LOG_LEVELS.WARN
    });
  var entry = { receiver: receiver, player: player, port: port, name: name, pairing: null, code: null, leaving: null };
  receiver.on('senderConnect', function (sender) {
    player.sender = sender;
    log.info('youtube: ' + (sender.user && sender.user.name || sender.name || 'a phone') + ' connected to ' + name);
  });
  receiver.on('senderDisconnect', function (sender) {
    log.info('youtube: ' + (sender.user && sender.user.name || sender.name || 'a phone') + ' left ' + name);
    var still = receiver.getConnectedSenders();
    player.sender = still.length ? still[still.length - 1] : null;
  });
  receiver.on('error', function (e) {
    log.warn('youtube: ' + name + ': ' + (e && e.message || e));
  });
  running.set(deviceId, entry);
  return receiver.start().then(function () {
    entry.unannounce = announce(port);
    log.info('youtube: "' + name + '" in the YouTube app\'s Cast list (DIAL :' + port + (interfaces.length ? ' on ' + interfaces.join(', ') : '') + ')');
  }, function (e) {
    running.delete(deviceId);
    // a port another program holds: the next one
    if (tries < 3 && /EADDRINUSE|address in use/i.test(String(e && e.message))) {
      return startOne(k, deviceId, name, tries + 1);
    }
    log.warn('youtube: could not start the receiver for ' + name + ': ' + (e && e.message || e));
    return null;
  });
}

function stopOne(deviceId) {
  return serial(function () {
    var r = running.get(deviceId);
    if (!r) {
      return null;
    }
    running.delete(deviceId);
    clearTimeout(r.leaving);
    if (r.unannounce) {
      r.unannounce();
    }
    if (r.pairing) {
      r.pairing.stop();
    }
    return r.receiver.stop().catch(function () {}).then(function () {
      log.info('youtube: "' + r.name + '" left the Cast list');
    });
  });
}

function stopAll() {
  return Promise.all(Array.from(running.keys()).map(stopOne));
}

// Every screen that should be in the list is, and only those
function sync() {
  if (!wanted()) {
    return stopAll();
  }
  return Promise.all(events.castScreens().filter(takesEmbeds).map(ensure));
}

function listen() {
  if (listening) {
    return;
  }
  listening = true;
  events.onScreen(function (deviceId, online) {
    if (!started) {
      return;
    }
    if (online) {
      ensure(deviceId);
      return;
    }
    var r = running.get(deviceId);
    if (r && !r.leaving) {
      r.leaving = setTimeout(function () {
        if (!takesEmbeds(deviceId)) {
          stopOne(deviceId);
        }
      }, GRACE_MS);
      if (r.leaving.unref) {
        r.leaving.unref();
      }
    }
  });
  events.onPublish(function (topic, data) {
    if ((topic === 'cast.updated' || topic === 'cast.ended') && data && data.deviceId) {
      var r = running.get(data.deviceId);
      if (r) {
        r.player.onCast(topic, data);
      }
    }
  });
}

/** The server started: receivers for the screens that take embeds, while cast.youtube is on */
function start(info, options) {
  started = !(info && info.recovery);
  lan = !!(options && options.lan);
  listen();
  return sync();
}

/** Settings changed (cast.*, the server's name) */
function refresh() {
  return stopAll().then(sync);
}

function stop() {
  started = false;
  return stopAll();
}

function status() {
  var list = [];
  running.forEach(function (r, deviceId) {
    list.push({
      deviceId: deviceId,
      name: r.name,
      port: r.port,
      senders: r.receiver.getConnectedSenders().map(function (s) { return s.user && s.user.name || s.name || 'A phone'; })
    });
  });
  return list;
}

/** The screen's "Link with TV code" (it changes every 5 minutes); null when its receiver isn't running */
function code(deviceId) {
  var r = running.get(deviceId);
  if (!r) {
    return Promise.resolve(null);
  }
  if (r.code && Date.now() - r.code.at < 4 * 60 * 1000) {
    return Promise.resolve(r.code.value);
  }
  if (!r.pairing) {
    r.pairing = r.receiver.getPairingCodeRequestService();
    r.pairing.on('response', function (value) {
      r.code = { value: String(value), at: Date.now() };
    });
    r.pairing.on('error', function (e) {
      log.warn('youtube: no TV code for ' + r.name + ': ' + (e && e.message || e));
      r.pairing = null;
    });
    r.pairing.start();
  }
  return new Promise(function (resolve) {
    var waited = 0, timer = setInterval(function () {
      waited += 250;
      if (r.code && Date.now() - r.code.at < 4 * 60 * 1000 || waited >= CODE_WAIT_MS || !r.pairing) {
        clearInterval(timer);
        resolve(r.code ? r.code.value : null);
      }
    }, 250);
  });
}

module.exports = {
  start: start,
  refresh: refresh,
  stop: stop,
  status: status,
  code: code,
  lanInterfaces: lanInterfaces,
  // tests: a screen's player without a receiver (nothing reaches YouTube)
  playerFor: function (deviceId) {
    listen();
    return ready().then(function (k) {
      var player = new k.c.ScreenPlayer(deviceId);
      running.set(deviceId, { receiver: { getConnectedSenders: function () { return []; }, stop: function () { return Promise.resolve(); } }, player: player, port: 0, name: 'test', pairing: null, code: null, leaving: null });
      return player;
    });
  },
  wanted: wanted
};
