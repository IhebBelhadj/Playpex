'use strict';

// Server log (docs/server-separation-plan.md §5.4):
//   • JSON lines in <logs>/playpex-server.log, rotated daily and at 10 MB,
//     7 files kept (lib/paths.js#logs)
//   • a ring buffer of the last 2 000 entries, for the dashboard (entries())
//   • a readable line on the console (stdout, warnings/errors on stderr)
//
//   var log = require('./logger').child('torrent');
//   log.info('ready', { infoHash: hash });
//   log.warn('yts list failed', { err: err });     // Errors become {message, code, stack}
//
// Entries: { time, level, area, msg, ...fields }. Never log tokens, API keys or
// query strings. Nothing is written to a file until configure({dir}) (start()).

var fs = require('fs'),
  path = require('path'),
  events = require('events');

var LEVELS = { debug: 10, info: 20, warn: 30, error: 40 },
  BASENAME = 'playpex-server',
  MAX_BYTES = 10 * 1024 * 1024,
  MAX_FILES = 7,          // the current file + 6 rotated ones
  BUFFER_SIZE = 2000;

var state = {
    level: LEVELS.info,
    console: true,
    dir: null,
    file: null,
    size: 0,
    day: null
  },
  buffer = [],
  emitter = new events.EventEmitter();

emitter.setMaxListeners(0);

function localDay(date) {
  var d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

function openFile() {
  state.file = null;
  if (!state.dir) {
    return;
  }
  try {
    fs.mkdirSync(state.dir, { recursive: true });
    var file = path.join(state.dir, BASENAME + '.log'), stat = null;
    try {
      stat = fs.statSync(file);
    } catch (e) { /* new file */ }
    state.file = file;
    state.size = stat ? stat.size : 0;
    state.day = localDay(stat ? stat.mtime : new Date());
  } catch (e) {
    process.stderr.write('[logger] no log file in ' + state.dir + ': ' + e.message + '\n');
  }
}

// playpex-server.log → playpex-server-<day>[-n].log, then keep the newest files
function rotate(now) {
  var target = path.join(state.dir, BASENAME + '-' + state.day + '.log'), n = 1;
  while (fs.existsSync(target)) {
    target = path.join(state.dir, BASENAME + '-' + state.day + '-' + (n++) + '.log');
  }
  fs.renameSync(state.file, target);
  state.size = 0;
  state.day = localDay(now);

  fs.readdirSync(state.dir)
    .filter(function (f) { return f.indexOf(BASENAME + '-') === 0 && /\.log$/.test(f); })
    .map(function (f) {
      var p = path.join(state.dir, f);
      return { path: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort(function (a, b) { return b.mtime - a.mtime; })
    .slice(MAX_FILES - 1)
    .forEach(function (f) { fs.unlinkSync(f.path); });
}

function writeFile(entry, now) {
  if (!state.file) {
    return;
  }
  var line = JSON.stringify(entry) + '\n';
  try {
    if (state.size > 0 && (state.size + line.length > MAX_BYTES || localDay(now) !== state.day)) {
      rotate(now);
    }
    fs.appendFileSync(state.file, line);
    state.size += Buffer.byteLength(line);
  } catch (e) {
    process.stderr.write('[logger] cannot write ' + state.file + ': ' + e.message + '\n');
    state.file = null;
  }
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function writeConsole(entry, now) {
  if (!state.console) {
    return;
  }
  var extra = Object.keys(entry).filter(function (k) {
    return ['time', 'level', 'area', 'msg'].indexOf(k) === -1;
  }).map(function (k) {
    var v = entry[k];
    return k + '=' + (k === 'err' && v ? v.message : (typeof v === 'object' ? JSON.stringify(v) : v));
  });
  var line = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()) + ' ' +
    entry.level.toUpperCase().padEnd(5) + ' [' + entry.area + '] ' + entry.msg +
    (extra.length ? ' ' + extra.join(' ') : '') + '\n';
  (LEVELS[entry.level] >= LEVELS.warn ? process.stderr : process.stdout).write(line);
}

function serializeError(err) {
  return { message: err.message, code: err.code, stack: err.stack };
}

function log(level, area, msg, fields) {
  if (LEVELS[level] < state.level) {
    return;
  }
  var now = new Date(), entry = {};
  Object.keys(fields || {}).forEach(function (k) {
    var v = fields[k];
    entry[k] = v instanceof Error ? serializeError(v) : v;
  });
  entry.time = now.toISOString();
  entry.level = level;
  entry.area = area;
  entry.msg = String(msg);

  buffer.push(entry);
  if (buffer.length > BUFFER_SIZE) {
    buffer.shift();
  }
  writeFile(entry, now);
  writeConsole(entry, now);
  emitter.emit('entry', entry);
}

function child(area) {
  return Object.keys(LEVELS).reduce(function (logger, level) {
    logger[level] = function (msg, fields) { log(level, area, msg, fields); };
    return logger;
  }, {});
}

/**
 * @param {{ level?: string, dir?: string|null, console?: boolean }} options
 */
function configure(options) {
  if (options.level && LEVELS[options.level]) {
    state.level = LEVELS[options.level];
  }
  if ('console' in options) {
    state.console = !!options.console;
  }
  if ('dir' in options && options.dir !== state.dir) {
    state.dir = options.dir;
    openFile();
  }
}

/**
 * Buffered entries, oldest first.
 * @param {{ level?: string, area?: string, plugin?: string, since?: string, limit?: number }} [filter]
 */
function entries(filter) {
  filter = filter || {};
  var min = LEVELS[filter.level] || 0;
  var list = buffer.filter(function (e) {
    return LEVELS[e.level] >= min &&
      (!filter.area || e.area === filter.area) &&
      (!filter.plugin || e.plugin === filter.plugin) &&
      (!filter.since || e.time > filter.since);
  });
  return filter.limit ? list.slice(-filter.limit) : list;
}

module.exports = {
  LEVELS: Object.keys(LEVELS),
  child: child,
  configure: configure,
  entries: entries,
  file: function () { return state.file; },
  on: emitter.on.bind(emitter),
  off: emitter.off.bind(emitter)
};
