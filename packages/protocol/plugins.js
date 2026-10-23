'use strict';

// The plugin contract (docs/plugins-plan.md, author guide docs/plugins/):
// SERVER_PLUGIN_API, the vocabulary of a manifest (permissions, hooks, events,
// write scopes, source kinds, templates, slots, effects), the sandbox's limits,
// and checkManifest(): the rules between a manifest's fields that its JSON
// schema (plugin.schema.json) can't express. Validate with the schema first,
// then checkManifest; the server does both at install (P4), the schema tests
// do both on the reference manifests.
//
// What crosses the sandbox at run time (hook i/o, sources, markers, effects,
// events, data answers) is plugin-api.schema.json; a repository's index is
// repository.schema.json, its signature signing.js (Node only).
// CommonJS with no dependencies, like index.js.

// Bumped only on breaking changes of the host API, hooks or events. A
// manifest's api.server range must contain it.
var SERVER_PLUGIN_API = 1;

var ID = /^[a-z][a-z0-9-]{1,31}$/;

// Hooks (§4.3): middleware stages of core features. Handlers run in `order`
// (the core's own handlers too); one that throws, times out or answers
// something its output schema refuses is skipped: it never fails the feature.
var HOOKS = {
  'play.collect': { timeoutMs: 8000, describe: 'Adds sources to Play' },
  'play.rank': { timeoutMs: 1000, describe: 'Reorders or hides the sources of Play' },
  'play.before': { timeoutMs: 1000, describe: 'Can ask before playing, or refuse' },
  // check: one batched call per Play (which torrents it can serve); resolve: the chosen one
  'play.resolve': { timeoutMs: 10000, checkTimeoutMs: 3000, describe: 'Plays torrents through a service (debrid)' },
  'releases.providers': { timeoutMs: 10000, describe: 'Adds release lists' },
  'subtitles.providers': { timeoutMs: 8000, describe: 'Adds subtitles' },
  'metadata.title': { timeoutMs: 3000, describe: 'Adds information to title pages' },
  'player.markers': { timeoutMs: 3000, describe: 'Marks intros, recaps and credits in the player' },
  // chosen per library folder by the admin (its information provider)
  'library.match': { timeoutMs: 10000, describe: 'Recognises the files of library folders it is chosen for' }
};

// Events (§4.4): what a plugin may observe, by family
var EVENTS = {
  playback: ['playback.started', 'playback.progress', 'playback.paused', 'playback.ended', 'playback.finished'],
  downloads: ['download.added', 'download.completed', 'download.removed'],
  library: ['library.changed'],
  watchlist: ['watchlist.added', 'watchlist.removed', 'watched.set', 'watched.cleared', 'rating.set']
};

var WRITE_SCOPES = ['watchlist', 'watched', 'ratings', 'downloads'];
var SOURCE_KINDS = ['magnet', 'http'];
var MARKER_KINDS = ['intro', 'recap', 'credits', 'chapter'];
var EFFECTS = ['open', 'play', 'toast', 'refresh', 'confirm', 'download'];
// No settings template: setup is the dashboard's, clients only show content (§1 goal 7)
var TEMPLATES = ['catalog', 'title', 'releases', 'list'];
var SETTING_TYPES = ['switch', 'choice', 'slider', 'number', 'text', 'secret', 'action'];
var LISTING_CATEGORIES = ['catalog', 'sources', 'resolvers', 'subtitles', 'metadata', 'library', 'tracking', 'notifications', 'tools'];

// Slots of core screens a packaged plugin may contribute to (the TV's slot
// catalog, apps/tv/src/app/ui/slots/slots.ts, has the same names), and what
// its data handler answers for each ($defs/slots/<kind> in plugin-api.schema.json)
var SLOTS = {
  'core.movie.actions': 'actions',
  'core.show.actions': 'actions',
  'core.episode.actions': 'actions',
  'core.movie.rows': 'rows',
  'core.show.rows': 'rows',
  'core.movies.rows': 'rows',
  'core.shows.rows': 'rows',
  'core.title.meta': 'meta',
  'core.watchlist.rows': 'rows',
  'core.search.filters': 'searchFilter'
};
var SLOT_MAX_PER_PLUGIN = 3;

// Permissions the admin also grants per profile in the dashboard, off until
// switched on, besides the install grant (§3, decision G)
var PERSONAL = ['events.playback', 'write.watchlist', 'write.watched', 'write.ratings'];

// What the sandbox allows (§4.1, §4.2, §4.5); a manifest may only ask for less
var LIMITS = {
  memoryBytes: 64 * 1024 * 1024,
  cpuMsPerCall: 2000,
  concurrentCalls: 4,
  http: { timeoutMs: 10000, maxResponseBytes: 8 * 1024 * 1024, perSecond: 2, burst: 10, inFlight: 4, maxWaitMs: 10000, maxRedirects: 5 },
  storageBytes: 100 * 1024 * 1024,
  dataBodyBytes: 1024 * 1024,
  schedule: { minIntervalMs: 5 * 60 * 1000, jitter: 0.1, maxRunMs: 5 * 60 * 1000 },
  eventQueue: 100,
  sourceRefTtlMs: 60 * 60 * 1000,
  notifications: { perHour: 10, keepMs: 24 * 60 * 60 * 1000 }
};

// Request headers an http source can't set: the server's own
var FORBIDDEN_HEADERS = ['host', 'cookie', 'connection', 'range', 'content-length', 'transfer-encoding'];

// Host names a manifest can't declare: they name this machine or the LAN
var LOCAL_SUFFIXES = ['localhost', 'local', 'lan', 'home', 'internal', 'intranet', 'corp', 'arpa', 'test', 'invalid', 'example'];

/** "10MB" → bytes, or null */
function parseSize(value) {
  var m = /^([1-9]\d{0,5})(KB|MB)$/.exec(String(value || ''));
  return m ? parseInt(m[1], 10) * (m[2] === 'KB' ? 1024 : 1024 * 1024) : null;
}

/** Whether a version range of the manifest's api (N, ^N, N.x, >=N, >=N <M, *) contains the integer version */
function satisfies(range, version) {
  var m;
  if (range === '*') {
    return true;
  }
  if ((m = /^\^?([1-9]\d*)(?:\.x)?$/.exec(range))) {
    return version === parseInt(m[1], 10);
  }
  if ((m = /^>=([1-9]\d*)(?: <([1-9]\d*))?$/.exec(range))) {
    return version >= parseInt(m[1], 10) && (!m[2] || version < parseInt(m[2], 10));
  }
  return false;
}

function semver(version) {
  var m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version || ''));
  return m ? [+m[1], +m[2], +m[3], m[4] || null] : null;
}

/** <0, 0, >0 like a sort comparator; a pre-release sorts before its release */
function compareVersions(a, b) {
  var x = semver(a), y = semver(b);
  for (var i = 0; i < 3; i++) {
    if (x[i] !== y[i]) {
      return x[i] - y[i];
    }
  }
  return x[3] === y[3] ? 0 : x[3] === null ? 1 : y[3] === null ? -1 : (x[3] < y[3] ? -1 : 1);
}

/**
 * Whether a plugin version is in a range of `requires` (1.2.3, ^1 / ^1.2 /
 * ^1.2.3, ~1.2 / ~1.2.3, 1.x, >=1.2.0, >=1.2.0 <2.0.0, *). Pre-releases
 * never satisfy a dependency.
 */
function satisfiesVersion(range, version) {
  var v = semver(version), m, low, high;
  if (!v || v[3]) {
    return false;
  }
  if (range === '*') {
    return true;
  }
  if (/^\d+\.\d+\.\d+$/.test(range)) {
    return compareVersions(version, range) === 0;
  }
  if ((m = /^>=(\d+\.\d+\.\d+)(?: <(\d+\.\d+\.\d+))?$/.exec(range))) {
    return compareVersions(version, m[1]) >= 0 && (!m[2] || compareVersions(version, m[2]) < 0);
  }
  if ((m = /^(\d+)\.x$/.exec(range))) {
    return v[0] === +m[1];
  }
  if ((m = /^([\^~])(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range))) {
    low = [+m[2], +(m[3] || 0), +(m[4] || 0)];
    // ^: same major (0.x: same minor); ~: same minor (~1: same major)
    high = m[1] === '^' ? (low[0] > 0 || m[3] === undefined ? [low[0] + 1, 0, 0] : [0, low[1] + 1, 0]) :
      (m[3] === undefined ? [low[0] + 1, 0, 0] : [low[0], low[1] + 1, 0]);
    return compareVersions(version, low.join('.')) >= 0 && compareVersions(version, high.join('.')) < 0;
  }
  return false;
}

/** Why a declared host isn't acceptable, or null */
function hostProblem(host) {
  var name = String(host).replace(/^\*\./, ''),
    labels = name.split('.');
  if (labels.every(function (l) { return /^\d+$/.test(l); })) {
    return 'an IP address: declare a host name';
  }
  if (LOCAL_SUFFIXES.indexOf(labels[labels.length - 1]) !== -1 || /(^|\.)home\.arpa$/.test(name)) {
    return 'a local or reserved name';
  }
  if (host.indexOf('*.') === 0 && labels.length < 2) {
    return 'a wildcard over a whole top-level domain';
  }
  return null;
}

/**
 * Whether `host` (a URL's host name) is one of the declared hosts: exact, or
 * under a `*.domain` pattern (a sub-domain, not the domain itself)
 */
function hostAllowed(patterns, host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  return (patterns || []).some(function (p) {
    return p.indexOf('*.') === 0 ? host.length > p.length - 1 && host.slice(-(p.length - 1)) === p.slice(1) : host === p;
  });
}

function hostOf(url) {
  var m = /^https:\/\/([^/:?#]+)/i.exec(url || '');
  return m ? m[1].toLowerCase() : null;
}

function names(list, field) {
  return (list || []).map(function (x) { return x[field]; });
}

function duplicates(list) {
  return list.filter(function (x, i) { return list.indexOf(x) !== i; });
}

/**
 * The rules between a manifest's fields (the schema checks each field alone).
 * `options.versions` ({ server, nav, ui }) are the API versions to check the
 * ranges against (server: SERVER_PLUGIN_API by default; nav / ui only when
 * given: they're the TV's); `options.files` the package's paths, to check that
 * the assets it names exist.
 * @returns {{ path: string, message: string }[]} empty when the manifest is fine
 */
function checkManifest(manifest, options) {
  options = options || {};
  var m = manifest || {},
    p = m.permissions || {},
    c = m.contributes || {},
    hooks = p.hooks || [],
    secrets = p.secrets || [],
    network = p.network || [],
    versions = Object.assign({ server: SERVER_PLUGIN_API }, options.versions),
    problems = [];

  function problem(path, message) {
    problems.push({ path: path, message: message });
  }

  // A repository package names its repository and nothing else
  if (m.type === 'repository') {
    var repoHost = hostOf(m.repository && m.repository.url);
    if (repoHost && hostProblem(repoHost)) {
      problem('/repository/url', repoHost + ' is ' + hostProblem(repoHost));
    }
    return problems;
  }

  Object.keys(versions).forEach(function (api) {
    if (m.api && m.api[api] && !satisfies(m.api[api], versions[api])) {
      problem('/api/' + api, 'needs ' + api + ' API ' + m.api[api] + ', this one is ' + versions[api]);
    }
  });

  network.forEach(function (host, i) {
    var why = hostProblem(host);
    if (why) {
      problem('/permissions/network/' + i, host + ' is ' + why);
    }
  });
  if (p.rateLimit) {
    ['perSecond', 'burst', 'inFlight'].forEach(function (k) {
      if (p.rateLimit[k] > LIMITS.http[k]) {
        problem('/permissions/rateLimit/' + k, 'may only be stricter than the default (' + LIMITS.http[k] + ')');
      }
    });
  }
  if (p.storage && parseSize(p.storage) > LIMITS.storageBytes) {
    problem('/permissions/storage', 'at most ' + (LIMITS.storageBytes / 1024 / 1024) + 'MB');
  }

  // Sources are used by play.collect, play.resolve (a debrid answers http
  // sources), play effects or download effects; an http source from a declared host
  if (p.sources && hooks.indexOf('play.collect') === -1 && hooks.indexOf('play.resolve') === -1 && !p.play &&
    (p.write || []).indexOf('downloads') === -1) {
    problem('/permissions/sources', 'sources need play.collect, play.resolve, play or write: downloads');
  }
  if (hooks.indexOf('play.collect') !== -1 && !p.sources) {
    problem('/permissions/hooks', 'play.collect needs permissions.sources (the kinds it returns)');
  }
  if ((p.sources || []).indexOf('http') !== -1 && !network.length) {
    problem('/permissions/sources', 'http sources need the stream hosts in permissions.network');
  }
  if (hooks.indexOf('play.resolve') !== -1 && (p.sources || []).indexOf('http') === -1) {
    problem('/permissions/hooks', 'play.resolve answers http sources: it needs permissions.sources http');
  }
  if (hooks.indexOf('library.match') !== -1 && !p.files) {
    problem('/permissions/hooks', 'library.match needs permissions.files (it sees the files\' names)');
  }

  // Dependencies
  var required = names(m.requires, 'id');
  duplicates(required).forEach(function (id) { problem('/requires', id + ' required twice'); });
  if (required.indexOf(m.id) !== -1) {
    problem('/requires', 'a plugin can\'t require itself');
  }
  if ((m.migratesFrom || []).indexOf(m.id) !== -1) {
    problem('/migratesFrom', 'a plugin can\'t replace itself');
  }

  // Audience: an adults plugin's titles are never the profile's
  if (m.audience === 'adults') {
    (p.write || []).forEach(function (scope) {
      if (scope !== 'downloads') {
        problem('/permissions/write', 'an adults plugin can\'t write ' + scope + ' (only downloads)');
      }
    });
  }
  if (c.chrome && c.chrome.accent === 'adult' && m.audience !== 'adults') {
    problem('/contributes/chrome/accent', 'the adult accent is for audience adults');
  }

  // Links: declared both ways, their secrets and hosts too
  var linkNames = names(m.link, 'name');
  duplicates(linkNames).forEach(function (n) { problem('/link', 'link ' + n + ' declared twice'); });
  linkNames.forEach(function (n, i) {
    if ((p.link || []).indexOf(n) === -1) {
      problem('/link/' + i, 'link ' + n + ' isn\'t in permissions.link');
    }
  });
  (p.link || []).forEach(function (n, i) {
    if (linkNames.indexOf(n) === -1) {
      problem('/permissions/link/' + i, 'permission for link ' + n + ' with no link of that name');
    }
  });
  (m.link || []).forEach(function (link, i) {
    var flow = link.deviceCode;
    if (!flow) {
      return;
    }
    ['clientIdSecret', 'clientSecretSecret'].forEach(function (k) {
      if (flow[k] && secrets.indexOf(flow[k]) === -1) {
        problem('/link/' + i + '/deviceCode/' + k, flow[k] + ' isn\'t in permissions.secrets');
      }
    });
    ['codeUrl', 'tokenUrl', 'refreshUrl'].forEach(function (k) {
      if (flow[k] && !hostAllowed(network, hostOf(flow[k]))) {
        problem('/link/' + i + '/deviceCode/' + k, 'its host isn\'t in permissions.network');
      }
    });
  });

  // Screens, sections, slots
  var screens = names(c.screens, 'name');
  duplicates(screens).forEach(function (n) { problem('/contributes/screens', 'screen ' + n + ' declared twice'); });
  (c.screens || []).forEach(function (s, i) {
    if (s.template !== 'settings' && !s.data) {
      problem('/contributes/screens/' + i, 'a ' + s.template + ' screen needs data (its handler)');
    }
  });
  (c.sections || []).forEach(function (s, i) {
    var screen = (c.screens || []).filter(function (x) { return x.name === s.screen; })[0];
    if (!screen) {
      problem('/contributes/sections/' + i + '/screen', 'no screen named ' + s.screen);
    } else if (screen.params && screen.params.length) {
      problem('/contributes/sections/' + i + '/screen', 'a section opens a screen without params');
    }
  });
  var perSlot = {};
  (c.slots || []).forEach(function (s) { perSlot[s.slot] = (perSlot[s.slot] || 0) + 1; });
  Object.keys(perSlot).forEach(function (slot) {
    if (perSlot[slot] > SLOT_MAX_PER_PLUGIN) {
      problem('/contributes/slots', 'at most ' + SLOT_MAX_PER_PLUGIN + ' contributions to ' + slot);
    }
  });

  // Settings
  var keys = names(c.settings, 'key'),
    byKey = {};
  (c.settings || []).forEach(function (s) { byKey[s.key] = s; });
  duplicates(keys).forEach(function (k) { problem('/contributes/settings', 'setting ' + k + ' declared twice'); });
  (c.settings || []).forEach(function (s, i) {
    var at = '/contributes/settings/' + i;
    ['visibleIf', 'enabledIf'].forEach(function (k) {
      var target = s[k] && byKey[s[k].key];
      if (s[k] && (!target || target === s || target.type === 'action' || target.type === 'secret')) {
        problem(at + '/' + k, 'must name another setting with a value');
      } else if (s[k] && target.scope !== s.scope && target.scope !== 'server') {
        problem(at + '/' + k, 'a ' + s.scope + ' setting can only depend on its scope or the server\'s');
      }
    });
    if (s.type === 'choice') {
      var values = (s.options || []).map(function (o) { return o[0]; });
      if (duplicates(values).length) {
        problem(at + '/options', 'option values must be unique');
      }
      if (values.indexOf(s.default) === -1) {
        problem(at + '/default', 'not one of the options');
      }
    }
    if (s.type === 'slider' && !(s.min < s.max && s.default >= s.min && s.default <= s.max)) {
      problem(at, 'needs min < max and the default between them');
    }
    if (s.type === 'number' && ((s.min !== undefined && s.default < s.min) || (s.max !== undefined && s.default > s.max) ||
        (s.min !== undefined && s.max !== undefined && s.min >= s.max) || (s.integer && Math.round(s.default) !== s.default))) {
      problem(at, 'needs min < max and a default between them (whole with integer)');
    }
    if (s.pattern !== undefined) {
      var re = null;
      try {
        re = new RegExp('^(?:' + s.pattern + ')$');
      } catch (e) {
        problem(at + '/pattern', 'not a regular expression');
      }
      if (s.type !== 'text') {
        problem(at + '/pattern', 'only text settings have a pattern');
      } else if (re && s.default != null && s.default !== '' && !re.test(s.default)) {
        problem(at + '/default', 'doesn\'t match the pattern');
      }
    }
    if (s.type === 'text' && s.default != null && s.maxLength && s.default.length > s.maxLength) {
      problem(at + '/default', 'longer than maxLength');
    }
    if (s.type === 'secret') {
      if (s.scope !== 'server') {
        problem(at + '/scope', 'a secret is entered by the admin: scope server');
      }
      if (secrets.indexOf(s.key) === -1) {
        problem(at + '/key', s.key + ' isn\'t in permissions.secrets');
      }
    }
  });

  // Assets the manifest names exist in the package
  if (options.files) {
    var assets = [['/icon', m.icon]],
      listing = m.listing || {};
    (c.sections || []).forEach(function (s, i) { assets.push(['/contributes/sections/' + i + '/menu/icon', s.menu && s.menu.icon]); });
    (listing.screenshots || []).forEach(function (a, i) { assets.push(['/listing/screenshots/' + i, a]); });
    assets.push(['/listing/fanart', listing.fanart]);
    assets.forEach(function (a) {
      if (a[1] && options.files.indexOf(a[1]) === -1) {
        problem(a[0], a[1] + ' isn\'t in the package');
      }
    });
  }

  // Translated strings: @key needs i18n/en.json (options.files) holding the key (options.strings.en)
  var refs = translated(m);
  if (refs.length && options.files && options.files.indexOf('i18n/en.json') === -1) {
    problem('/', 'uses @keys without i18n/en.json');
  }
  if (options.strings) {
    refs.forEach(function (r) {
      if (!options.strings.en || typeof options.strings.en[r.key] !== 'string') {
        problem(r.path, '@' + r.key + ' isn\'t in i18n/en.json');
      }
    });
  }

  return problems;
}

/** The @key strings of a manifest: [{ path, key }] */
function translated(m) {
  var found = [];
  (function walk(value, path) {
    if (typeof value === 'string') {
      var k = /^@([A-Za-z][A-Za-z0-9._-]{0,63})$/.exec(value);
      if (k) {
        found.push({ path: path, key: k[1] });
      }
    } else if (value && typeof value === 'object') {
      Object.keys(value).forEach(function (key) { walk(value[key], path + '/' + key); });
    }
  })(m, '');
  return found;
}

/**
 * Every permission of a manifest in plain words, for the admin at install and
 * the profiles' opt-in (§3, §6): [{ key, text, personal }]
 */
function describePermissions(manifest) {
  var m = manifest || {},
    p = m.permissions || {},
    out = [];

  function add(key, text) {
    out.push({ key: key, text: text, personal: PERSONAL.indexOf(key) !== -1 });
  }

  if (m.audience === 'adults') {
    add('audience', 'Adult content: hidden from kids profiles');
  }
  if (p.network && p.network.length) {
    add('network', 'Talks to ' + p.network.join(', '));
  }
  if (p.storage) {
    add('storage', 'Keeps up to ' + p.storage.replace(/(KB|MB)$/, ' $1') + ' of its own data');
  }
  (p.secrets || []).forEach(function (s) {
    add('secrets.' + s, 'Asks for: ' + s);
  });
  if (p.play) {
    add('play', 'Can start playback');
  }
  if (p.sources) {
    add('sources', 'Adds ' + p.sources.map(function (k) { return k === 'magnet' ? 'torrents' : 'streams from the web'; }).join(' and ') + ' to Play');
  }
  (p.hooks || []).forEach(function (h) {
    if (h !== 'play.collect' || !p.sources) {
      add('hooks.' + h, HOOKS[h] ? HOOKS[h].describe : h);
    }
  });
  var EVENT_TEXT = { playback: 'Sees what you watch', downloads: 'Sees the server\'s downloads', library: 'Sees what\'s added to the library', watchlist: 'Sees your watch list, watched marks and ratings' };
  (p.events || []).forEach(function (f) {
    add('events.' + f, EVENT_TEXT[f]);
  });
  if (p.schedule) {
    add('schedule', 'Runs in the background');
  }
  var WRITE_TEXT = { watchlist: 'Can change your watch list', watched: 'Can mark titles watched and save where you stopped', ratings: 'Can rate titles for you', downloads: 'Can add downloads' };
  (p.write || []).forEach(function (s) {
    add('write.' + s, WRITE_TEXT[s]);
  });
  (m.link || []).forEach(function (l) {
    add('link.' + l.name, 'Links ' + (l.scope === 'profile' ? 'your ' : 'the server\'s ') + l.label + ' account');
  });
  if (p.library) {
    add('library', 'Sees what\'s on this server');
  }
  if (p.files) {
    add('files', 'Sees the names of your video files');
  }
  if (p.notify) {
    add('notify', 'Can show you notifications');
  }
  (m.requires || []).forEach(function (r) {
    add('requires.' + r.id, (r.optional ? 'Works better with: ' : 'Installs with: ') + r.id);
  });
  return out;
}

module.exports = {
  SERVER_PLUGIN_API: SERVER_PLUGIN_API,
  ID: ID,
  HOOKS: HOOKS,
  EVENTS: EVENTS,
  WRITE_SCOPES: WRITE_SCOPES,
  SOURCE_KINDS: SOURCE_KINDS,
  MARKER_KINDS: MARKER_KINDS,
  EFFECTS: EFFECTS,
  TEMPLATES: TEMPLATES,
  SETTING_TYPES: SETTING_TYPES,
  LISTING_CATEGORIES: LISTING_CATEGORIES,
  SLOTS: SLOTS,
  SLOT_MAX_PER_PLUGIN: SLOT_MAX_PER_PLUGIN,
  PERSONAL: PERSONAL,
  LIMITS: LIMITS,
  FORBIDDEN_HEADERS: FORBIDDEN_HEADERS,
  parseSize: parseSize,
  satisfies: satisfies,
  satisfiesVersion: satisfiesVersion,
  compareVersions: compareVersions,
  hostAllowed: hostAllowed,
  checkManifest: checkManifest,
  describePermissions: describePermissions
};
