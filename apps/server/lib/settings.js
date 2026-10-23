'use strict';

// Server settings: <config>/settings.json (docs/server-separation-plan.md §5.3),
// meant to be edited from the dashboard. Read by start() before anything else
// (port, bind address, download dir are needed first).
//
// Environment variables win over the file (Docker, the dev .env); `sources()`
// tells which keys they lock. Only keys of defaults() exist: unknown keys in
// the file are dropped, wrong types fall back to the default.
//
//   settings.get('general.port')            effective value
//   settings.update({ general: { port: 28480 } })
//     → { settings: <public view>, changed, restartRequired: ['general.port'], lockedByEnv }

var fs = require('fs'),
  os = require('os'),
  path = require('path'),
  paths = require('./paths');

var FILE = path.join(paths.config, 'settings.json');

var DEFAULT_PORT = 28470;
var LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

// Whole numbers ≥ 1 (counts, minutes)
var POSITIVE_INTEGERS = ['streaming.maxTorrents', 'streaming.maxTranscodes', 'streaming.idleTimeoutMinutes',
  'security.pairingRequestMinutes', 'downloads.maxActive'];
// Whole numbers ≥ 0 (0 = off)
var NON_NEGATIVE_INTEGERS = ['downloads.seedMinutes', 'downloads.uploadSlots'];
// Ports (1024–65535) other than the HTTP one
var PORTS = ['downloads.peerPort', 'dlna.port'];
// Numbers ≥ 0
var NON_NEGATIVE = ['downloads.seedRatio'];

function defaults() {
  return {
    general: {
      serverName: os.hostname(),
      port: DEFAULT_PORT,
      logLevel: 'info'
    },
    network: {
      // true: listen on every interface (LAN clients pair first, lib/auth);
      // false: loopback only (127.0.0.1)
      lanSharing: true,
      // advertise this server on the LAN (mDNS + UDP 28471, lib/discovery.js);
      // only with lanSharing
      discovery: true,
      allowedHosts: [],   // extra Host names (a DNS name pointing at this machine)
      corsOrigins: []     // extra web origins allowed to call the API
    },
    security: {
      // false: clients on this machine (loopback) need no pairing
      requirePairingOnLoopback: false,
      // how long a pairing code a client shows stays valid
      pairingRequestMinutes: 10
    },
    storage: {
      downloadDir: ''     // '' = <cache>/torrent_data (lib/paths.js)
    },
    streaming: {
      maxTorrents: 4,         // active torrents at once (streams + downloads); past it a new stream → 503 BUSY
      maxTranscodes: 2,       // ffmpeg audio transcodes at once (one per device and file)
      idleTimeoutMinutes: 10  // a client lease with no request / keepalive for this long is dropped
    },
    downloads: {
      // the torrent engine (lib/torrents/engines); applied after a restart
      engine: require('./torrents/engines').DEFAULT,
      peerPort: 6881,     // BitTorrent port (TCP / uTP); taken → a free one; applied after a restart
      portForwarding: false,   // ask the router to forward peerPort (UPnP), when the engine can
      maxActive: 3,       // downloads (not streams) running at once; the others wait, queued
      // a finished download seeds until either is reached (0 = no limit of
      // that kind); both 0 = it doesn't seed
      seedRatio: 1,
      seedMinutes: 0,
      uploadSlots: 10,    // peers uploaded to at once per torrent; 0 = never upload
      paused: false       // "Pause all downloads" (the tray): downloads wait, streams still play
    },
    dlna: {
      // the UPnP AV / DLNA media server (lib/dlna): TVs and players on the LAN
      // browse the library's folders marked "include in DLNA" without pairing;
      // only with lanSharing
      enabled: false,
      port: 28472         // its own HTTP listener (read-only media, no auth)
    },
    plugins: {
      // unsigned plugin packages install (at once), and the folders of
      // <config>/plugins-dev/<id>/ load (authors testing their own; after a
      // restart); docs/plugins-plan.md §6.3 decision C
      developerMode: false,
      // publisher keys (`ed25519:…`) whose signed packages install without
      // developer mode (lib/plugins/install.js)
      publisherKeys: [],
      // updates from repositories (docs/plugins-plan.md §6.4): auto installs
      // those asking for no new permissions (the rest wait for the admin),
      // notify only lists them, never doesn't look; a plugin can override it
      updates: 'auto'
    },
    providers: {
      tmdbApiKey: '',
      openSubtitlesApiKey: '',
      wyzieApiKey: ''
    },
    transcoding: {
      ffmpegPath: '',     // '' = bundled copy, else the PATH (lib/ffmpeg.js)
      ffprobePath: ''
    }
  };
}

// key → environment variables, first set one wins
var ENV = {
  'general.port': ['PLAYPEX_PORT', 'STREAMER_PORT'],
  'general.logLevel': ['PLAYPEX_LOG_LEVEL'],
  'network.lanSharing': ['PLAYPEX_LAN_SHARING'],
  'network.discovery': ['PLAYPEX_DISCOVERY'],
  'dlna.enabled': ['PLAYPEX_DLNA'],
  'storage.downloadDir': ['PLAYPEX_DOWNLOAD_DIR'],
  'downloads.engine': ['PLAYPEX_TORRENT_ENGINE'],
  'providers.tmdbApiKey': ['TMDB_API_KEY'],
  'providers.openSubtitlesApiKey': ['OPENSUBTITLES_API_KEY'],
  'providers.wyzieApiKey': ['WYZIE_API_KEY'],
  'transcoding.ffmpegPath': ['FFMPEG_PATH'],
  'transcoding.ffprobePath': ['FFPROBE_PATH']
};

// Applied on the next start only
var RESTART = ['general.port', 'network.lanSharing', 'security.pairingRequestMinutes', 'storage.downloadDir',
  'downloads.engine', 'downloads.peerPort', 'downloads.portForwarding', 'plugins.developerMode'];

// Never returned in full by publicView()
var SECRETS = ['providers.tmdbApiKey', 'providers.openSubtitlesApiKey', 'providers.wyzieApiKey'];

var stored = null,      // what settings.json holds (validated)
  effective = null,     // stored + environment
  envKeys = {};         // key → env var that set it

function keys(obj, prefix) {
  return Object.keys(obj).reduce(function (all, k) {
    var v = obj[k], key = prefix ? prefix + '.' + k : k;
    return all.concat(v && typeof v === 'object' && !Array.isArray(v) ? keys(v, key) : [key]);
  }, []);
}

function read(obj, key) {
  return key.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
}

function write(obj, key, value) {
  var parts = key.split('.'), last = parts.pop();
  parts.reduce(function (o, k) { return o[k]; }, obj)[last] = value;
}

function validatePort(value) {
  var port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return 'port must be a whole number between 1024 and 65535';
  }
  return null;
}

// value converted to the default's type, or an error message
function coerce(key, value, fromEnv) {
  var def = read(defaults(), key);
  if (typeof def === 'number') {
    var n = Number(value);
    if (key === 'general.port') {
      var err = validatePort(value);
      return err ? { error: err } : { value: n };
    }
    if (PORTS.indexOf(key) !== -1) {
      return validatePort(value) ? { error: key.split('.')[1] + ': ' + validatePort(value) } : { value: n };
    }
    if (POSITIVE_INTEGERS.indexOf(key) !== -1) {
      return Number.isInteger(n) && n >= 1 ? { value: n } : { error: key + ' must be a whole number of at least 1' };
    }
    if (NON_NEGATIVE_INTEGERS.indexOf(key) !== -1) {
      return Number.isInteger(n) && n >= 0 ? { value: n } : { error: key + ' must be a whole number of at least 0' };
    }
    if (NON_NEGATIVE.indexOf(key) !== -1) {
      return Number.isFinite(n) && n >= 0 ? { value: n } : { error: key + ' must be a number of at least 0' };
    }
    return Number.isFinite(n) ? { value: n } : { error: key + ' must be a number' };
  }
  if (typeof def === 'boolean') {
    if (typeof value === 'boolean') {
      return { value: value };
    }
    if (fromEnv && /^(1|true|yes|on)$/i.test(value)) {
      return { value: true };
    }
    if (fromEnv && /^(0|false|no|off)$/i.test(value)) {
      return { value: false };
    }
    return { error: key + ' must be true or false' };
  }
  if (Array.isArray(def)) {
    if (fromEnv) {
      value = String(value).split(',');
    }
    if (!Array.isArray(value) || value.some(function (v) { return typeof v !== 'string'; })) {
      return { error: key + ' must be a list of strings' };
    }
    var list = value.map(function (v) { return v.trim(); }).filter(Boolean);
    if (key === 'plugins.publisherKeys') {
      var bad = list.filter(function (k) {
        try {
          require('@playpex/protocol/signing').publicKey(k);
          return false;
        } catch (e) {
          return true;
        }
      });
      if (bad.length) {
        return { error: 'publisherKeys: not an ed25519 public key (ed25519:<base64>): ' + bad[0].slice(0, 60) };
      }
    }
    return { value: list };
  }
  if (typeof value !== 'string') {
    return { error: key + ' must be a string' };
  }
  if (key === 'plugins.updates' && ['auto', 'notify', 'never'].indexOf(value) === -1) {
    return { error: 'plugins.updates must be auto, notify or never' };
  }
  if (key === 'general.logLevel' && LOG_LEVELS.indexOf(value) === -1) {
    return { error: 'logLevel must be one of ' + LOG_LEVELS.join(', ') };
  }
  if (key === 'general.serverName' && !value.trim()) {
    return { error: 'serverName must not be empty' };
  }
  if (key === 'storage.downloadDir' && value.trim() && !path.isAbsolute(value.trim())) {
    return { error: 'downloadDir must be an absolute path' };
  }
  if (key === 'downloads.engine' && require('./torrents/engines').choices().indexOf(value.trim()) === -1) {
    return { error: 'engine must be one of ' + require('./torrents/engines').choices().join(', ') };
  }
  return { value: value.trim() };
}

function compute() {
  effective = JSON.parse(JSON.stringify(stored));
  envKeys = {};
  Object.keys(ENV).forEach(function (key) {
    var name = ENV[key].filter(function (n) { return process.env[n] !== undefined && process.env[n] !== ''; })[0];
    if (!name) {
      return;
    }
    var result = coerce(key, process.env[name], true);
    if (result.error) {
      warn('ignoring ' + name + ': ' + result.error);
      return;
    }
    write(effective, key, result.value);
    envKeys[key] = name;
  });
}

// lib/logger requires nothing from here, but is configured from these settings:
// require it late
function warn(msg) {
  require('./logger').child('settings').warn(msg);
}

// (Re)reads settings.json. A broken file is reported and left untouched (the
// defaults are used), so a typo never wipes the user's settings.
function load() {
  var data = {};
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      warn('settings.json unreadable, using defaults: ' + e.message);
    }
  }
  stored = defaults();
  keys(stored).forEach(function (key) {
    var value = read(data, key);
    if (value === undefined) {
      return;
    }
    var result = coerce(key, value, false);
    if (result.error) {
      warn('settings.json: ' + result.error + ', using the default');
    } else {
      write(stored, key, result.value);
    }
  });
  compute();
  return effective;
}

function ensure() {
  if (!effective) {
    load();
  }
}

function get(key) {
  ensure();
  return read(effective, key);
}

// 'env' (locked by an environment variable), 'file' or 'default'
function sources() {
  ensure();
  var def = defaults();
  return keys(def).reduce(function (all, key) {
    all[key] = envKeys[key] ? 'env' : (JSON.stringify(read(stored, key)) !== JSON.stringify(read(def, key)) ? 'file' : 'default');
    return all;
  }, {});
}

function mask(value) {
  return value ? '••••' + value.slice(-4) : '';
}

// For the dashboard: effective values with secrets masked, and where each comes from
function publicView() {
  ensure();
  var view = JSON.parse(JSON.stringify(effective));
  SECRETS.forEach(function (key) { write(view, key, mask(read(view, key))); });
  return { settings: view, sources: sources(), env: Object.assign({}, envKeys) };
}

// Merges `patch` into settings.json (atomically). Throws an Error with
// code 'INVALID_SETTINGS' and the list of problems; nothing is saved then.
// A masked secret sent back unchanged is ignored.
function update(patch) {
  ensure();
  var next = JSON.parse(JSON.stringify(stored)),
    changed = [],
    errors = [];
  keys(defaults()).forEach(function (key) {
    var value = read(patch || {}, key);
    if (value === undefined || (SECRETS.indexOf(key) !== -1 && value === mask(read(stored, key)) && value)) {
      return;
    }
    var result = coerce(key, value, false);
    if (result.error) {
      errors.push(result.error);
    } else if (JSON.stringify(result.value) !== JSON.stringify(read(next, key))) {
      write(next, key, result.value);
      changed.push(key);
    }
  });
  if (errors.length) {
    var err = new Error(errors.join('; '));
    err.code = 'INVALID_SETTINGS';
    err.errors = errors;
    throw err;
  }
  if (changed.length) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    var tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, FILE);
    stored = next;
    compute();
  }
  return {
    settings: publicView(),
    changed: changed,
    restartRequired: changed.filter(function (k) { return RESTART.indexOf(k) !== -1; }),
    lockedByEnv: changed.filter(function (k) { return envKeys[k]; })
  };
}

module.exports = {
  FILE: FILE,
  DEFAULT_PORT: DEFAULT_PORT,
  LOG_LEVELS: LOG_LEVELS,
  load: load,
  get: get,
  sources: sources,
  publicView: publicView,
  update: update,
  validatePort: validatePort
};
