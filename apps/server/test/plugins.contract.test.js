'use strict';

// The plugin contract (docs/plugins-plan.md P0): the manifest schema plus
// checkManifest() accept the reference manifests (plugins/velvet, plugins/trakt)
// and refuse what a manifest must never get through; the run-time schema
// (plugin-api.schema.json) accepts the shapes the host will hand over and
// refuses the ones it must not.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('path'),
  crypto = require('crypto'),
  Ajv2020 = require('ajv/dist/2020'),
  plugins = require('@playpex/protocol/plugins'),
  signing = require('@playpex/protocol/signing');

var ROOT = path.join(__dirname, '..', '..', '..'),
  ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true, validateFormats: false }),
  manifestSchema = require('@playpex/protocol/plugin.schema.json'),
  apiSchema = require('@playpex/protocol/plugin-api.schema.json'),
  repositorySchema = require('@playpex/protocol/repository.schema.json');

ajv.addSchema(apiSchema);
ajv.addSchema(manifestSchema);
var validateManifest = ajv.getSchema(manifestSchema.$id),
  validateIndex = ajv.compile(repositorySchema);

function api(def) {
  return ajv.getSchema(apiSchema.$id + '#/$defs/' + def);
}

function hook(name, side) {
  return ajv.getSchema(apiSchema.$id + '#/$defs/hooks/' + name + '/' + side);
}

/** Schema errors and checkManifest problems of a manifest, as strings */
function problems(manifest, options) {
  var errors = validateManifest(manifest) ? [] :
    validateManifest.errors.map(function (e) { return 'schema ' + e.instancePath + ' ' + e.message; });
  return errors.length ? errors : plugins.checkManifest(manifest, options).map(function (p) { return p.path + ' ' + p.message; });
}

function reference(id) {
  return JSON.parse(JSON.stringify(require(path.join(ROOT, 'plugins', id, 'playpex-plugin.json'))));
}

function minimal(extra) {
  return Object.assign({
    id: 'sample',
    name: 'Sample',
    version: '1.0.0',
    publisher: { name: 'Someone' },
    api: { server: '^1' },
    audience: 'everyone',
    permissions: {}
  }, extra);
}

test('the reference manifests are valid', function () {
  ['velvet', 'trakt'].forEach(function (id) {
    assert.deepEqual(problems(reference(id), { versions: { nav: 1, ui: 1 } }), [], id);
  });
});

test('the example plugin (plugins/hello) is valid, with its translations', function () {
  var strings = { en: require(path.join(ROOT, 'plugins', 'hello', 'i18n', 'en.json')) };
  assert.deepEqual(problems(reference('hello'), { versions: { nav: 1, ui: 1 }, strings: strings }), []);
});

test('settings: number (bounds, integer), text pattern; a section opens a screen without params', function () {
  function withSettings(settings) {
    return minimal({ contributes: { settings: settings } });
  }
  var number = { key: 'n', scope: 'server', type: 'number', label: 'N', default: 5 };
  assert.deepEqual(problems(withSettings([number])), []);
  assert.deepEqual(problems(withSettings([Object.assign({}, number, { min: 1, max: 10, integer: true, unit: 's' })])), []);
  assert.notDeepEqual(problems(withSettings([Object.assign({}, number, { min: 6 })])), [], 'default under min');
  assert.notDeepEqual(problems(withSettings([Object.assign({}, number, { default: 2.5, integer: true })])), [], 'not whole');
  assert.notDeepEqual(problems(withSettings([Object.assign({}, number, { options: [] })])), [], 'no options on a number');
  var text = { key: 't', scope: 'profile', type: 'text', label: 'T', pattern: '[a-z]+', default: 'abc', placeholder: 'abc' };
  assert.deepEqual(problems(withSettings([text])), []);
  assert.notDeepEqual(problems(withSettings([Object.assign({}, text, { default: 'ABC' })])), [], 'default doesn\'t match');
  assert.notDeepEqual(problems(withSettings([Object.assign({}, text, { pattern: '(' })])), [], 'not a regex');
  assert.notDeepEqual(problems(withSettings([{ key: 's', scope: 'server', type: 'switch', label: 'S', default: true, pattern: 'x' }])), []);
  var sections = minimal({ contributes: {
    screens: [{ name: 'title', template: 'title', data: 'title', params: ['id'] }],
    sections: [{ screen: 'title', menu: { label: 'T', icon: 'assets/x.svg' } }]
  } });
  assert.ok(problems(sections).some(function (p) { return /without params/.test(p); }));
});

test('a minimal manifest is valid', function () {
  assert.deepEqual(problems(minimal()), []);
});

test('ids, versions and API ranges', function () {
  ['Adult', 'a', '1abc', 'with_underscore', 'x'.repeat(33)].forEach(function (id) {
    assert.notDeepEqual(problems(minimal({ id: id })), [], id);
  });
  ['1', '1.0', 'v1.0.0', '1.0.0+build'].forEach(function (v) {
    assert.notDeepEqual(problems(minimal({ version: v })), [], v);
  });
  assert.notDeepEqual(problems(minimal({ api: { server: '^2' } })), [], 'a future host API');
  assert.notDeepEqual(problems(minimal({ api: { server: '~1.2' } })), [], 'an unknown range form');
  assert.deepEqual(problems(minimal({ api: { server: '>=1 <3' } })), []);
  assert.notDeepEqual(problems(minimal({ api: { server: '^1', ui: '^2' } }), { versions: { ui: 1 } }), []);
  assert.notDeepEqual(problems(minimal({ unknownField: true })), [], 'unknown top-level fields');
});

test('undeclared hooks, events and scopes are refused', function () {
  assert.notDeepEqual(problems(minimal({ permissions: { hooks: ['play.everything'] } })), []);
  assert.notDeepEqual(problems(minimal({ permissions: { events: ['auth'] } })), []);
  assert.notDeepEqual(problems(minimal({ permissions: { write: ['profiles'] } })), []);
  assert.notDeepEqual(problems(minimal({ permissions: { fs: true } })), [], 'unknown permissions');
  assert.notDeepEqual(problems(minimal({ contributes: { slots: [{ slot: 'core.player.overlay', data: 'x' }] } })), []);
});

test('private, local and IP hosts are refused', function () {
  ['127.0.0.1', '192.168.1.10', '10.0.0.1', '8.8.8.8', 'localhost', 'nas.local', 'router.lan', 'box.home.arpa',
    'api.internal', '*.com', 'http://example.org', 'example.org:8080', 'example.org/path', '::1', 'EXAMPLE.org'
  ].forEach(function (host) {
    assert.notDeepEqual(problems(minimal({ permissions: { network: [host] } })), [], host);
  });
  ['api.trakt.tv', '*.real-debrid.com', 'xn--bcher-kva.example.de'].forEach(function (host) {
    assert.deepEqual(problems(minimal({ permissions: { network: [host] } })), [], host);
  });
});

test('sources need a use (collect, resolve, play, downloads), and http sources a declared host', function () {
  assert.notDeepEqual(problems(minimal({ permissions: { sources: ['magnet'] } })), []);
  assert.deepEqual(problems(minimal({ permissions: { sources: ['magnet'], play: true } })), []);
  assert.deepEqual(problems(minimal({ permissions: { hooks: ['play.resolve'], sources: ['http'], network: ['api.debrid.example.com'] } })), [],
    'a resolver alone needs no play.collect');
  assert.notDeepEqual(problems(minimal({ permissions: { hooks: ['play.collect'] } })), []);
  assert.notDeepEqual(problems(minimal({ permissions: { hooks: ['play.collect'], sources: ['http'] } })), []);
  assert.notDeepEqual(problems(minimal({ permissions: { hooks: ['play.collect'], sources: ['ftp'], network: ['a.example.com'] } })), []);
  assert.deepEqual(problems(minimal({ permissions: { hooks: ['play.collect'], sources: ['http'], network: ['*.debrid.example.com'] } })), []);
});

test('limits can only be stricter', function () {
  assert.notDeepEqual(problems(minimal({ permissions: { network: ['a.b.com'], rateLimit: { perSecond: 50 } } })), []);
  assert.deepEqual(problems(minimal({ permissions: { network: ['a.b.com'], rateLimit: { perSecond: 0.5, burst: 2 } } })), []);
  assert.notDeepEqual(problems(minimal({ permissions: { storage: '500MB' } })), []);
  assert.notDeepEqual(problems(minimal({ permissions: { storage: '10GB' } })), []);
});

test('the audience rule', function () {
  var adult = reference('velvet');
  adult.permissions.write = ['downloads', 'watchlist'];
  assert.notDeepEqual(problems(adult), [], 'an adults plugin writing the watch list');
  assert.notDeepEqual(problems(minimal({ contributes: { chrome: { accent: 'adult' } } })), [], 'the adult accent outside adults');
  assert.notDeepEqual(problems(minimal({ audience: 'kids' })), []);
});

test('links match their permission, secrets and hosts', function () {
  var trakt = reference('trakt');
  trakt.permissions.link = ['simkl'];
  assert.equal(problems(trakt).length, 2, 'a link without permission, a permission without link');
  trakt = reference('trakt');
  trakt.permissions.secrets = ['traktClientId'];
  assert.match(problems(trakt).join('\n'), /clientSecretSecret/);
  trakt = reference('trakt');
  trakt.link[0].deviceCode.tokenUrl = 'https://evil.example.com/token';
  assert.match(problems(trakt).join('\n'), /tokenUrl/);
  trakt = reference('trakt');
  trakt.link[0].deviceCode.codeUrl = 'http://api.trakt.tv/oauth/device/code';
  assert.notDeepEqual(problems(trakt), [], 'not HTTPS');
});

test('screens, sections, slots and settings hold together', function () {
  var adult = reference('velvet');
  adult.contributes.sections[0].screen = 'nothing';
  assert.match(problems(adult).join('\n'), /no screen named nothing/);
  adult = reference('velvet');
  adult.contributes.screens.push({ name: 'browse', template: 'list', data: 'x' });
  assert.match(problems(adult).join('\n'), /declared twice/);
  adult = reference('velvet');
  delete adult.contributes.screens[0].data;
  assert.match(problems(adult).join('\n'), /needs data/);
  adult = reference('velvet');
  adult.contributes.settings[0].default = 'grid';
  assert.match(problems(adult).join('\n'), /not one of the options/);
  adult = reference('velvet');
  adult.contributes.settings[1].scope = 'profile';
  assert.match(problems(adult).join('\n'), /scope server/);
  adult = reference('velvet');
  adult.permissions.secrets = [];
  assert.match(problems(adult).join('\n'), /theporndbApiKey isn't in permissions.secrets/);
  var many = minimal({ contributes: { slots: [1, 2, 3, 4].map(function (n) { return { slot: 'core.movie.rows', data: 'r' + n }; }) } });
  assert.match(problems(many).join('\n'), /at most 3/);
  assert.notDeepEqual(problems(minimal({ contributes: { settings: [{ key: 'a', scope: 'profile', type: 'switch', label: 'A' }] } })), [],
    'a switch without default');
  assert.notDeepEqual(problems(minimal({ contributes: { settings: [{ key: 'a', scope: 'profile', type: 'slider', label: 'A', min: 5, max: 1, default: 3 }] } })), []);
  assert.notDeepEqual(problems(minimal({ icon: 'assets/../server.js' })), [], 'an asset outside assets/');
  assert.notDeepEqual(problems(minimal({ icon: 'assets/x.svg' }), { files: ['playpex-plugin.json', 'server.js'] }), [], 'a missing asset');
  assert.deepEqual(problems(minimal({ icon: 'assets/x.svg' }), { files: ['assets/x.svg'] }), []);
});

test('permissions in plain words', function () {
  var words = plugins.describePermissions(reference('trakt')),
    personal = words.filter(function (w) { return w.personal; }).map(function (w) { return w.key; });
  assert.deepEqual(personal.sort(), ['events.playback', 'write.ratings', 'write.watched', 'write.watchlist']);
  assert.ok(words.some(function (w) { return w.text === 'Talks to api.trakt.tv'; }));
  assert.ok(plugins.describePermissions(reference('velvet')).some(function (w) { return /hidden from kids/.test(w.text); }));
});

test('host matching', function () {
  assert.ok(plugins.hostAllowed(['api.trakt.tv'], 'api.trakt.tv'));
  assert.ok(plugins.hostAllowed(['api.trakt.tv'], 'API.trakt.tv.'));
  assert.ok(!plugins.hostAllowed(['api.trakt.tv'], 'evil-api.trakt.tv'));
  assert.ok(plugins.hostAllowed(['*.example.com'], 'cdn.example.com'));
  assert.ok(plugins.hostAllowed(['*.example.com'], 'a.b.example.com'));
  assert.ok(!plugins.hostAllowed(['*.example.com'], 'example.com'));
  assert.ok(!plugins.hostAllowed(['*.example.com'], 'badexample.com'));
  assert.ok(!plugins.hostAllowed(undefined, 'example.com'));
});

test('run-time shapes: sources, effects, events, hook answers', function () {
  var source = api('source'), effect = api('effect'), event = api('event'), titleRef = api('titleRef');
  assert.ok(source({ kind: 'magnet', label: '1080p', infoHash: 'a'.repeat(40), seeds: 10 }));
  assert.ok(!source({ kind: 'magnet', label: 'nothing to play' }), 'a magnet source without magnet or hash');
  assert.ok(source({ kind: 'http', label: 'Debrid', url: 'https://cdn.example.com/f.mkv', headers: { Authorization: 'Bearer x' } }));
  assert.ok(!source({ kind: 'http', label: 'plain', url: 'http://cdn.example.com/f.mkv' }), 'not HTTPS');
  assert.ok(!source({ kind: 'file', label: 'a path', path: '/etc/passwd' }), 'no file sources');

  assert.ok(titleRef({ kind: 'episode', tmdbId: 1396, season: 1, episode: 2 }));
  assert.ok(!titleRef({ kind: 'episode', tmdbId: 1396 }), 'an episode without its numbers');

  assert.ok(effect({ type: 'play', request: { title: 'X', sources: [{ kind: 'magnet', label: 'a', infoHash: 'b'.repeat(40) }], tracking: 'none' } }));
  assert.ok(effect({ type: 'confirm', question: 'Sure?', then: { type: 'call', call: { data: 'doIt' } } }));
  assert.ok(effect({ type: 'open', intent: { screen: 'plugin.adult.title', params: { id: 12 } } }));
  assert.ok(effect({ type: 'open', intent: { screen: 'core.movie', params: { id: 12 } } }));
  assert.ok(!effect({ type: 'open', intent: { screen: 'core.settings' } }), 'core screens beyond the titles and search');
  assert.ok(!effect({ type: 'eval', code: 'alert(1)' }));
  assert.ok(!effect({ type: 'confirm', question: 'Sure?', then: { type: 'confirm', question: 'Really?', then: { type: 'call', call: { data: 'x', args: {} }, extra: 1 } } }));

  var ctx = { profile: { id: 'p1', kids: false }, device: null, locale: 'en' };
  assert.ok(event({ name: 'playback.progress', time: new Date().toISOString(), context: ctx,
    data: { title: { kind: 'movie', tmdbId: 27205 }, position: 60, duration: 8880, source: 'torrent' } }));
  assert.ok(!event({ name: 'playback.progress', time: 'now', context: ctx,
    data: { title: { kind: 'movie', tmdbId: 27205 }, position: 60, duration: 8880, source: 'torrent', magnet: 'magnet:?xt=…' } }),
    'a playback event never carries the magnet');
  assert.ok(!event({ name: 'device.paired', time: 'now', context: ctx, data: {} }));

  assert.ok(hook('play.rank', 'output')({ order: ['a', 'b'], hide: [{ id: 'c', reason: 'HEVC' }] }));
  assert.ok(!hook('play.rank', 'output')({ hide: [{ id: 'c' }] }), 'hiding needs a reason');
  assert.ok(hook('play.before', 'output')({ action: 'refuse', reason: 'Not tonight' }));
  assert.ok(!hook('play.before', 'output')({ action: 'play-something-else' }));
  assert.ok(hook('player.markers', 'output')([{ kind: 'intro', start: 30, end: 95 }, { kind: 'credits', start: 2500 }]));
  assert.ok(!hook('player.markers', 'output')([{ kind: 'ad', start: 0 }]));
  assert.ok(hook('releases.providers', 'output')({ releases: [{ title: 'X 1080p', infoHash: 'c'.repeat(40), seeds: 3 }], last: true }));
});

test('every hook has an input and an output schema', function () {
  Object.keys(plugins.HOOKS).forEach(function (name) {
    assert.ok(hook(name, 'input'), name + ' input');
    assert.ok(hook(name, 'output'), name + ' output');
  });
  assert.deepEqual(Object.keys(apiSchema.$defs.hooks).sort(), Object.keys(plugins.HOOKS).sort());
});

test('the manifest schema and plugins.js name the same things', function () {
  var p = manifestSchema.$defs.permissions.properties;
  assert.deepEqual(p.hooks.items.enum.slice().sort(), Object.keys(plugins.HOOKS).sort());
  assert.deepEqual(p.events.items.enum.slice().sort(), Object.keys(plugins.EVENTS).sort());
  assert.deepEqual(p.write.items.enum, plugins.WRITE_SCOPES);
  assert.deepEqual(p.sources.items.enum, plugins.SOURCE_KINDS);
  assert.deepEqual(manifestSchema.$defs.contributes.properties.slots.items.properties.slot.enum.slice().sort(),
    Object.keys(plugins.SLOTS).sort());
  assert.deepEqual(manifestSchema.$defs.contributes.properties.screens.items.properties.template.enum, plugins.TEMPLATES);
  var events = [].concat.apply([], Object.keys(plugins.EVENTS).map(function (f) { return plugins.EVENTS[f]; }));
  assert.deepEqual(apiSchema.$defs.event.properties.name.enum.slice().sort(), events.sort());
  assert.deepEqual(apiSchema.$defs.effect.oneOf.map(function (e) { return e.properties.type.const; }), plugins.EFFECTS);
  Object.keys(plugins.SLOTS).forEach(function (slot) {
    assert.ok(api('slots/' + plugins.SLOTS[slot]), slot + ' has an answer schema');
  });
  assert.ok(api('slots/searchFilter')({ chip: { key: 'adult:search', label: '18+' }, rows: [{ key: 'adult:results', title: 'Results', page: { data: 'search' } }] }));
  assert.ok(!api('slots/rows')([{ key: 'x:r', title: 'Both', items: [], page: { data: 'p' } }]), 'a row is items or paged, not both');
});

// ── P0b: the revision of 2026-10-23 (dashboard-only setup, repositories, Kodi features) ──

function setting(extra) {
  return Object.assign({ key: 'a', scope: 'profile', type: 'switch', label: 'A', default: true }, extra);
}

test('no setup on clients: no settings template, no device settings, no showCode', function () {
  assert.notDeepEqual(problems(minimal({ contributes: { screens: [{ name: 'opts', template: 'settings' }] } })), []);
  assert.notDeepEqual(problems(minimal({ contributes: { settings: [setting({ scope: 'device' })] } })), []);
  assert.ok(!api('effect')({ type: 'showCode', code: 'ABCD', url: 'https://x.example.com', poll: 'p' }));
  assert.equal(plugins.TEMPLATES.indexOf('settings'), -1);
  assert.equal(plugins.EFFECTS.indexOf('showCode'), -1);
});

test('settings: groups, levels, conditions, actions', function () {
  var ok = minimal({ contributes: { settings: [
    setting({ key: 'sync', type: 'choice', options: [['on', 'On'], ['off', 'Off']], default: 'on', group: 'Sync' }),
    setting({ key: 'often', type: 'slider', min: 1, max: 24, default: 6, unit: 'h', level: 'advanced', visibleIf: { key: 'sync', equals: 'on' } }),
    setting({ key: 'syncNow', type: 'action', data: 'syncNow', confirm: 'Sync now?', enabledIf: { key: 'sync', equals: 'on' } })
  ] } });
  delete ok.contributes.settings[2].default;
  assert.deepEqual(problems(ok), []);
  assert.notDeepEqual(problems(minimal({ contributes: { settings: [setting({ type: 'action' })] } })), [], 'an action without data');
  assert.match(problems(minimal({ contributes: { settings: [setting({ visibleIf: { key: 'nothing', equals: true } })] } })).join('\n'), /another setting/);
  assert.match(problems(minimal({ contributes: { settings: [setting({ visibleIf: { key: 'a', equals: true } })] } })).join('\n'), /another setting/, 'itself');
  var onServer = minimal({ contributes: { settings: [setting({ key: 'b', scope: 'server' }), setting({ visibleIf: { key: 'b', equals: true } })] } });
  assert.deepEqual(problems(onServer), [], 'a profile setting may depend on a server one');
  var onProfile = minimal({ contributes: { settings: [setting({ key: 'b' }), setting({ scope: 'server', visibleIf: { key: 'b', equals: true } })] } });
  assert.match(problems(onProfile).join('\n'), /can only depend/);
  assert.notDeepEqual(problems(minimal({ contributes: { settings: [setting({ level: 'expert' })] } })), []);
});

test('links: a device code or a custom handler, not both', function () {
  var trakt = reference('trakt');
  trakt.link[0].custom = 'linkTrakt';
  assert.notDeepEqual(problems(trakt), [], 'both');
  trakt = reference('trakt');
  delete trakt.link[0].deviceCode;
  assert.notDeepEqual(problems(trakt), [], 'neither');
  trakt.link[0].custom = 'linkTrakt';
  assert.deepEqual(problems(trakt), []);
  assert.ok(api('linkStart')({ code: 'AB12CD', url: 'https://real-debrid.com/device', poll: 'linkPoll', qr: true }));
  assert.ok(api('linkStart')({ form: [{ key: 'apiKey', label: 'API key', secret: true }], submit: 'saveKey' }));
  assert.ok(!api('linkStart')({ code: 'AB12CD', url: 'http://plain.example.com', poll: 'p' }));
  assert.ok(api('linkPoll')({ state: 'done' }));
});

test('new hooks need their permissions', function () {
  assert.match(problems(minimal({ permissions: { hooks: ['play.resolve'] } })).join('\n'), /play.resolve/);
  assert.match(problems(minimal({ permissions: { hooks: ['play.resolve'], sources: ['magnet'] } })).join('\n'), /play.resolve/);
  assert.deepEqual(problems(minimal({ permissions: { hooks: ['play.collect', 'play.resolve'], sources: ['http'], network: ['*.real-debrid.com'] } })), []);
  assert.match(problems(minimal({ permissions: { hooks: ['library.match'] } })).join('\n'), /permissions.files/);
  assert.deepEqual(problems(minimal({ permissions: { hooks: ['library.match'], files: true, network: ['api.anidb.net'] } })), []);
});

test('play.resolve and library.match shapes', function () {
  var input = hook('play.resolve', 'input'), output = hook('play.resolve', 'output');
  assert.ok(input({ mode: 'check', hashes: ['a'.repeat(40)] }));
  assert.ok(input({ mode: 'resolve', title: { kind: 'movie', tmdbId: 1 }, source: { kind: 'magnet', label: 'x', infoHash: 'a'.repeat(40) } }));
  assert.ok(output({ hashes: { ['a'.repeat(40)]: { cached: true, label: 'Real-Debrid' } } }));
  assert.ok(output({ source: { kind: 'http', label: 'Real-Debrid', url: 'https://cdn.real-debrid.com/x.mkv' } }));
  assert.ok(output({ source: null }));
  assert.ok(!output({ hashes: { NOTAHASH: { cached: true } } }));
  var match = hook('library.match', 'output');
  assert.ok(hook('library.match', 'input')({ file: { relPath: 'Show/[Group] Show - 1043.mkv', folderKind: 'shows', parse: { kind: 'episode' } } }));
  assert.ok(!hook('library.match', 'input')({ file: { relPath: 'x.mkv', folderKind: 'shows', fullPath: '/home/me/x.mkv' } }), 'never the full path');
  assert.ok(match({ identity: { kind: 'episode', showTmdbId: 37854, season: 21, episode: 1 } }));
  assert.ok(match({ identity: null }));
  assert.ok(!match({ identity: { kind: 'music', tmdbId: 1 } }), 'only the core\'s kinds');
  assert.ok(api('notification')({ text: 'Downloaded: The Bear S03E02', tone: 'success', key: 'dl' }));
  assert.ok(!api('notification')({ text: 'x'.repeat(121) }));
});

test('listing, dependencies, exports', function () {
  assert.deepEqual(problems(minimal({
    listing: { summary: 'S', categories: ['sources', 'resolvers'], screenshots: ['assets/s1.jpg'], license: 'MIT', source: 'https://github.com/x/y' },
    requires: [{ id: 'debrid', version: '^1' }, { id: 'trakt', version: '>=1.2.0 <2.0.0', optional: true }],
    exports: ['resolve'],
    migratesFrom: ['old-sample']
  })), []);
  assert.notDeepEqual(problems(minimal({ listing: { categories: ['games'] } })), []);
  assert.match(problems(minimal({ requires: [{ id: 'sample', version: '^1' }] })).join('\n'), /itself/);
  assert.match(problems(minimal({ requires: [{ id: 'a1', version: '^1' }, { id: 'a1', version: '^2' }] })).join('\n'), /twice/);
  assert.notDeepEqual(problems(minimal({ requires: [{ id: 'a1', version: 'latest' }] })), []);
  assert.match(problems(minimal({ migratesFrom: ['sample'] })).join('\n'), /itself/);
  assert.match(problems(minimal({ listing: { screenshots: ['assets/s1.jpg'] } }), { files: [] }).join('\n'), /s1.jpg/);
  var words = plugins.describePermissions(minimal({ requires: [{ id: 'debrid', version: '^1' }], permissions: { files: true, notify: true } }))
    .map(function (w) { return w.text; });
  assert.deepEqual(words, ['Sees the names of your video files', 'Can show you notifications', 'Installs with: debrid']);
});

test('dependency version ranges', function () {
  [['^1', '1.4.0', true], ['^1', '2.0.0', false], ['^0.3', '0.3.9', true], ['^0.3', '0.4.0', false], ['^1.2.3', '1.2.2', false],
    ['~1.2', '1.2.9', true], ['~1.2', '1.3.0', false], ['~1', '1.9.0', true], ['1.x', '1.0.0', true], ['1.2.3', '1.2.3', true],
    ['>=1.2.0 <2.0.0', '1.9.9', true], ['>=1.2.0 <2.0.0', '2.0.0', false], ['*', '3.0.0', true], ['^1', '1.2.0-beta', false]
  ].forEach(function (c) {
    assert.equal(plugins.satisfiesVersion(c[0], c[1]), c[2], c[0] + ' ' + c[1]);
  });
  assert.ok(plugins.compareVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(plugins.compareVersions('1.10.0', '1.9.9') > 0);
});

test('translations: @keys need i18n/en.json', function () {
  var m = minimal({ contributes: { settings: [setting({ label: '@scrobble' })] } });
  assert.deepEqual(problems(m), []);
  assert.match(problems(m, { files: ['playpex-plugin.json'] }).join('\n'), /i18n\/en.json/);
  assert.match(problems(m, { files: ['i18n/en.json'], strings: { en: {} } }).join('\n'), /@scrobble/);
  assert.deepEqual(problems(m, { files: ['i18n/en.json'], strings: { en: { scrobble: 'Scrobble' } } }), []);
});

test('repository packages', function () {
  var keys = signing.generate(),
    repo = { type: 'repository', id: 'example-repo', name: 'Example plugins', version: '1.0.0', publisher: { name: 'Example' },
      repository: { url: 'https://plugins.example.org/index.json', key: keys.publicKey } };
  assert.deepEqual(problems(repo), []);
  assert.notDeepEqual(problems(Object.assign({}, repo, { permissions: {} })), [], 'a repository package runs nothing');
  assert.notDeepEqual(problems(Object.assign({}, repo, { repository: { url: 'http://plugins.example.org/index.json', key: keys.publicKey } })), []);
  assert.match(problems(Object.assign({}, repo, { repository: { url: 'https://nas.local/index.json', key: keys.publicKey } })).join('\n'), /local/);
  assert.notDeepEqual(problems(Object.assign({}, minimal(), { repository: repo.repository })), [], 'a plugin can\'t carry a repository');
});

test('repository indexes and their signatures', function () {
  var keys = signing.generate(),
    sha = crypto.createHash('sha256').update('package').digest('hex'),
    index = {
      format: 1,
      repository: { id: 'example', name: 'Example plugins', key: keys.publicKey },
      generatedAt: '2026-10-23T10:00:00Z',
      plugins: [{
        id: 'trakt', name: 'Trakt', publisher: { name: 'Playpex' }, icon: 'https://plugins.example.org/trakt.svg',
        listing: { summary: 'Scrobbles', categories: ['tracking'], screenshots: ['https://plugins.example.org/s.jpg'] },
        versions: [
          { version: '1.1.0', url: 'https://plugins.example.org/trakt-1.1.0.ppx', sha256: sha, size: 4000, releasedAt: '2026-10-22',
            api: { server: '^1' }, audience: 'everyone', permissions: { network: ['api.trakt.tv'] }, changelog: 'Fixes' },
          { version: '1.0.0', url: 'https://plugins.example.org/trakt-1.0.0.ppx', sha256: sha, size: 4000, releasedAt: '2026-10-01',
            lifecycle: 'broken', reason: 'Trakt changed its API' }
        ]
      }]
    };
  assert.ok(validateIndex(index), JSON.stringify(validateIndex.errors));

  function bad(change, why) {
    var copy = JSON.parse(JSON.stringify(index));
    change(copy);
    assert.ok(!validateIndex(copy), why);
  }
  bad(function (i) { delete i.plugins[0].versions[0].sha256; }, 'no sha256');
  bad(function (i) { i.plugins[0].versions[0].url = 'http://plugins.example.org/x.ppx'; }, 'not HTTPS');
  bad(function (i) { delete i.plugins[0].versions[1].reason; }, 'broken without a reason');
  bad(function (i) { i.plugins[0].versions[0].permissions = { network: ['x.example.com'], fs: true }; }, 'unknown permissions');
  bad(function (i) { i.format = 2; }, 'another format');

  var bytes = Buffer.from(JSON.stringify(index)),
    sig = signing.sign(bytes, keys.privateKey);
  assert.ok(signing.verify(bytes, sig, keys.publicKey));
  var tampered = Buffer.from(bytes);
  tampered[10] ^= 1;
  assert.ok(!signing.verify(tampered, sig, keys.publicKey), 'one byte changed');
  assert.ok(!signing.verify(bytes, sig, signing.generate().publicKey), 'another key');
  assert.ok(!signing.verify(bytes, 'not base64!', keys.publicKey));
  assert.ok(!signing.verify(bytes, sig, 'ed25519:short'));
  assert.match(signing.fingerprint(keys.publicKey), /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
});

test('P0b names agree between the schemas and plugins.js', function () {
  assert.deepEqual(manifestSchema.properties.listing.properties.categories.items.enum, plugins.LISTING_CATEGORIES);
  assert.deepEqual(manifestSchema.$defs.setting.properties.type.enum, plugins.SETTING_TYPES);
});
