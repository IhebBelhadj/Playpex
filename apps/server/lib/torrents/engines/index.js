'use strict';

// The engine registry (docs/media-server-plan.md §4.3): the only way to get an
// engine adapter. Adapters are required on use, so choosing one never loads
// the others.
//
//   engines.ids()          every registered engine
//   engines.choices()      the ones a user can pick (setting downloads.engine)
//   engines.available(id)  { ok, detail }: can it run here (a sidecar engine: is it installed)
//   engines.describe()     the user's choices for the dashboard: [{ id, name, summary, available, detail,
//                          installable, installed, version }]
//   engines.install(id, { log }) / uninstall(id)   the optional sidecar engines (./sidecar.js)
//   DEFAULT                the default of downloads.engine; FALLBACK runs when the chosen one can't start
//   engines.create(id, options?)  → a new adapter instance (../port.js Engine), not
//                          initialised; options are the adapter's own (tests)

// name / summary: what the dashboard shows next to the choice (measured, see
// docs/media-server-plan.md step 1b notes)
var REGISTRY = {
  'torrent-stream': {
    user: true,
    name: 'torrent-stream',
    summary: 'Built for streaming: seeking fetches the needed pieces first. Checks the data on disk again each time a torrent resumes (slow for big files), no speed limits.',
    load: function () { return require('./torrent-stream'); }
  },
  rqbit: {
    user: true,
    name: 'rqbit',
    summary: 'A torrent client (Rust, runs beside the server): resumes at once, real pause, uTP. Weak at seeking: a jump in a video that is still downloading can take tens of seconds. Best for downloads.',
    load: function () { return require('./rqbit'); }
  },
  torrentd: {
    user: true,
    name: 'playpex-torrentd',
    summary: 'Recommended for streaming. Our engine on anacrolix/torrent (Go, runs beside the server): starts as fast as torrent-stream, a seek is served in about 2 s, resumes at once without re-checking, real pause, speed limits.',
    load: function () { return require('./torrentd'); }
  },
  // in-process emulation, for the tests (test/engines.test.js, test/downloads.test.js)
  fake: { user: false, load: function () { return require('./fake'); } }
};

var DEFAULT = 'torrent-stream',
  FALLBACK = 'torrent-stream';

function create(id, options) {
  var entry = REGISTRY[id];
  if (!entry) {
    throw new Error('Unknown torrent engine: ' + id);
  }
  return entry.load().create(options);
}

var sidecar = require('./sidecar');

// the sidecar spec of an engine that is its own program, else null
function specOf(id) {
  var entry = REGISTRY[id];
  return entry ? entry.load().spec || null : null;
}

function available(id) {
  if (!REGISTRY[id]) {
    return { ok: false, detail: 'unknown engine' };
  }
  var spec = specOf(id);
  if (spec && !sidecar.find(spec)) {
    return { ok: false, detail: REGISTRY[id].name + ' is not installed' };
  }
  return { ok: true, detail: null };
}

function describe() {
  return Object.keys(REGISTRY).filter(function (id) { return REGISTRY[id].user; }).map(function (id) {
    var a = available(id), spec = specOf(id), found = spec ? sidecar.find(spec) : null;
    return {
      id: id, name: REGISTRY[id].name, summary: REGISTRY[id].summary, available: a.ok, detail: a.detail,
      // an optional download: installable here, installed (by us, or found on the PATH / an env path)
      installable: !!spec && sidecar.installable(spec),
      installed: spec ? found ? found.source : null : 'builtin',
      version: spec ? (found && found.version) || null : null,
      latest: spec && spec.release ? spec.release.version : null
    };
  });
}

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function install(id, options) {
  var spec = specOf(id);
  if (!spec) {
    return Promise.reject(failure(REGISTRY[id] ? 'INVALID' : 'NOT_FOUND', REGISTRY[id] ? id + ' is built in' : 'No engine ' + id));
  }
  return sidecar.install(spec, options);
}

function uninstall(id) {
  var spec = specOf(id);
  if (!spec) {
    return Promise.reject(failure(REGISTRY[id] ? 'INVALID' : 'NOT_FOUND', REGISTRY[id] ? id + ' is built in' : 'No engine ' + id));
  }
  return sidecar.uninstall(spec);
}

module.exports = {
  DEFAULT: DEFAULT,
  FALLBACK: FALLBACK,
  available: available,
  describe: describe,
  install: install,
  uninstall: uninstall,
  spec: specOf,
  ids: function () { return Object.keys(REGISTRY); },
  choices: function () { return Object.keys(REGISTRY).filter(function (id) { return REGISTRY[id].user; }); },
  create: create
};
