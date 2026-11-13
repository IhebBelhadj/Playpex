'use strict';

// Section rows on a real server (docs/rows-plan.md §3–§7, lib/rows), TMDB stubbed:
//
//   the built-in layouts (today's TV rows), personal rows left out until there is something in them
//   a plugin's declared offers (contributes.rows) joining as one plugin.all entry, filled one row at a time,
//     their pictures through the server, values (a genre) reaching the handler, a title of the plugin's own,
//     what the profile watched left out of a personal offer's row
//   a plugin with only the old slot (core.shows.rows) expanding to its slot's rows, paged ones too
//   editing: the layout to edit with the joined plugin and `known`, a plugin taken out not joining again,
//     a single plugin row taking its offer out of plugin.all, bad layouts refused, Reset; kids: the admin's only;
//     the admin's default for every profile without its own
//   Because you watched, from the profile's history; the sources the editors list; every answer against openapi.yaml

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-rows-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  tmdb = require('../lib/tmdb'),
  rowsLib = require('../lib/rows');

var ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(YAML.parse(fs.readFileSync(require.resolve('@playpex/protocol/openapi.yaml'), 'utf8')), 'spec');

function conforms(schema, value) {
  var validate = ajv.getSchema('spec#/components/schemas/' + schema);
  assert.ok(validate(value), schema + ': ' + ajv.errorsText(validate.errors));
}

// ── a canned TMDB ───────────────────────────────────────────────────────────

function movie(id, title, genres) {
  return { id: id, title: title, release_date: '2001-01-01', overview: '', poster_path: '/' + id + '.jpg', genre_ids: genres || [28], vote_average: 7, vote_count: 900 };
}

var asked = [];
tmdb.get = function (apiPath, params) {
  asked.push({ path: apiPath, params: params });
  if (/^\/(movie|trending|discover)\b/.test(apiPath) && !/\/recommendations$/.test(apiPath)) {
    var page = (params && params.page) || 1;
    return Promise.resolve({ page: page, total_pages: 3, total_results: 60, results: [movie(949, 'Heat'), movie(862, 'Toy Story', [16, 10751])] });
  }
  if (/^\/(tv|discover\/tv)/.test(apiPath)) {
    return Promise.resolve({ page: 1, total_pages: 1, total_results: 1, results: [{ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', genre_ids: [18] }] });
  }
  return Promise.reject(Object.assign(new Error('no canned answer for ' + apiPath), { response: { status: 404 } }));
};
tmdb.recommendations = function (ref) {
  return Promise.resolve(ref.tmdbId === 949 ? [
    { mediaType: 'movie', tmdbId: 807, title: 'Se7en', genreIds: [80], adult: false },
    { mediaType: 'movie', tmdbId: 862, title: 'Toy Story', genreIds: [16, 10751], adult: false }
  ] : []);
};

// ── plugins: one with offers, one with only the old slot ─────────────────────

function plugin(id, manifest, code) {
  var dir = path.join(tmp, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify(Object.assign({
    id: id, name: id.charAt(0).toUpperCase() + id.slice(1), version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1.6' }, audience: 'everyone'
  }, manifest)));
  fs.writeFileSync(path.join(dir, 'server.js'), code);
  return dir;
}

var SHELF = plugin('shelf', {
  permissions: { network: ['img.example.com'], images: ['img.example.com'] },
  contributes: {
    rows: [
      { key: 'picks', title: 'Shelf picks', sections: ['home', 'movies'], joins: ['movies'], data: 'row', args: { list: 'picks' },
        params: [{ key: 'genre', label: 'Genre', options: [['action', 'Action'], ['comedy', 'Comedy']] }], personal: true, candidates: true },
      { key: 'paged', title: 'Shelf pages', sections: ['movies'], joins: ['movies'], data: 'row', args: { list: 'paged' } },
      { key: 'only', title: 'Only offered', sections: ['home'], data: 'row', args: { list: 'only' } }
    ]
  }
}, [
  'function card(id, title) { return { key: "m" + id, title: title, image: "https://img.example.com/" + id + ".jpg", intent: { screen: "core.movie", params: { id: id } } }; }',
  'playpex.data("row", function (args) {',
  '  if (args.list === "picks") {',
  '    var items = [card(949, "Heat"), card(807, "Se7en"), { key: "own", title: "Its own", intent: { screen: "plugin.shelf.title", params: {} } }];',
  '    return { data: { items: items, last: true, title: args.values.genre ? "Picks: " + args.values.genre : undefined } };',
  '  }',
  '  if (args.list === "paged") { return { data: { items: [card(100 + args.page, "Page " + args.page)], last: args.page >= 2 } }; }',
  '  return { data: { items: [card(1, "One")], last: true } };',
  '});'
].join('\n'));

var OLDROWS = plugin('oldrows', {
  api: { server: '^1' },
  permissions: {},
  contributes: { slots: [{ slot: 'core.shows.rows', data: 'showRows' }] }
}, [
  'playpex.data("showRows", function () { return { data: [',
  '  { key: "oldrows:now", title: "Now", items: [{ key: "a", title: "A", intent: { screen: "core.show", params: { id: 1396 } } }] },',
  '  { key: "oldrows:all", title: "All", page: { data: "page", args: { what: "all" } } }',
  '] }; });',
  'playpex.data("page", function (args) { return { data: { items: [{ key: "p" + args.page, title: "P" + args.page }], last: args.page >= 2 } }; });'
].join('\n'));

// ── the server ──────────────────────────────────────────────────────────────

var base = null, cookie = null, ana = null, kid = null;

function call(method, apiPath, body, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: method, agent: false,
      headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload ? { 'Content-Type': 'application/json' } : {},
        options.admin && cookie ? { Cookie: cookie } : {})
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8'), json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, json: json, text: text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function ok(res, status) {
  assert.equal(res.status, status || 200, res.text);
  return res.json;
}

function rowsOf(section, profile) {
  return call('GET', '/sections/' + section + '/rows' + (profile ? '?profile=' + profile : '')).then(function (r) {
    var body = ok(r);
    conforms('SectionRows', body);
    return body.rows;
  });
}

function items(section, id, profile, page) {
  return call('GET', '/sections/' + section + '/rows/' + encodeURIComponent(id) + '/items?profile=' + profile + (page ? '&page=' + page : '')).then(function (r) {
    var body = ok(r);
    conforms('RowPage', body);
    return body;
  });
}

function layout(section, profile) {
  return call('GET', '/sections/' + section + '/layout?profile=' + profile).then(function (r) {
    var body = ok(r);
    conforms('SectionLayout', body);
    return body;
  });
}

test.before(function () {
  return server.start({
    port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false },
    plugins: { dirs: [SHELF, OLDROWS], installed: false }
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return call('POST', '/admin/setup', { username: 'admin', password: 'rows-pass-1' });
  }).then(function () {
    return new Promise(function (resolve, reject) {
      var req = http.request(new URL('/api/v1/auth/sign-in/username', base), {
        method: 'POST', agent: false, headers: { 'Content-Type': 'application/json' }
      }, function (res) {
        cookie = [].concat(res.headers['set-cookie'])[0].split(';')[0];
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end(Buffer.from(JSON.stringify({ username: 'admin', password: 'rows-pass-1' })));
    });
  }).then(function () {
    return call('POST', '/profiles', { name: 'Ana' });
  }).then(function (r) {
    ana = ok(r, 201).id;
    return call('POST', '/profiles', { name: 'Kid', isKid: true });
  }).then(function (r) {
    kid = ok(r, 201).id;
  });
});

test.after(function () {
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('Movies: the built-in rows, nothing personal yet, the offering plugin joined at the end', function () {
  return rowsOf('movies', ana).then(function (rows) {
    var ids = rows.map(function (r) { return r.id; });
    assert.equal(ids.indexOf('r_movcontinue'), -1, 'Continue watching: empty, left out');
    assert.equal(ids[0], 'r_movtrending');
    assert.equal(rows[0].title, 'Trending');
    var joined = rowsLib.joinId('shelf');
    assert.deepEqual(rows.slice(-2).map(function (r) { return r.id; }), [joined + '~picks', joined + '~paged']);
    assert.ok(rows.slice(-2).every(function (r) { return r.new && r.kind === 'cards' && r.plugin === 'shelf'; }));
    assert.equal(rows.filter(function (r) { return r.plugin === 'oldrows'; }).length, 0, 'its slot is for TV shows');
    assert.ok(!rows.some(function (r) { return /~only$/.test(r.id); }), 'offered only, not joining');
  });
});

test('a core row\'s pages come from the catalog; kids get titles for them', function () {
  return items('movies', 'r_movtrending', ana, 2).then(function (page) {
    assert.equal(page.kind, 'titles');
    assert.deepEqual(page.items.map(function (t) { return t.tmdbId; }), [949, 862]);
    assert.equal(page.last, false);
    var last = asked.filter(function (a) { return a.path === '/movie/popular'; }).pop();
    assert.equal(last.params.page, 2);
    return items('movies', 'r_movtrending', kid);
  }).then(function (page) {
    assert.deepEqual(page.items.map(function (t) { return t.tmdbId; }), [862], 'only the family film');
    return items('shows', 'r_tvnewseries', ana);
  }).then(function () {
    var last = asked.filter(function (a) { return a.path === '/discover/tv'; }).pop();
    assert.match(last.params['first_air_date.gte'], /^\d{4}-\d{2}-\d{2}$/, 'recentYears → a date two years back');
    assert.equal(last.params.without_genres, '10763,10764,10767');
  });
});

test('a plugin\'s offer, filled on its own: pictures through the server, watched titles left out', function () {
  var id = rowsLib.joinId('shelf') + '~picks';
  return items('movies', id, ana).then(function (page) {
    assert.equal(page.kind, 'cards');
    assert.equal(page.plugin, 'shelf');
    assert.deepEqual(page.items.map(function (c) { return c.title; }), ['Heat', 'Se7en', 'Its own']);
    assert.match(page.items[0].image, /^images\/[A-Za-z0-9_.-]+$/);
    return call('PUT', '/profiles/' + ana + '/watched/movie/949', { title: 'Heat', genreIds: [28], durationS: 6000 });
  }).then(function (r) {
    ok(r);
    rowsLib.clearCache();
    return items('movies', id, ana);
  }).then(function (page) {
    assert.deepEqual(page.items.map(function (c) { return c.title; }), ['Se7en', 'Its own'], 'a personal offer hides what Ana watched');
    return items('movies', rowsLib.joinId('shelf') + '~paged', ana, 2);
  }).then(function (page) {
    assert.deepEqual(page.items.map(function (c) { return c.title; }), ['Page 2']);
    assert.equal(page.last, true);
  });
});

test('a plugin of before layouts: its slot\'s rows, paged ones too', function () {
  return rowsOf('shows', ana).then(function (rows) {
    var old = rows.filter(function (r) { return r.plugin === 'oldrows'; });
    assert.deepEqual(old.map(function (r) { return r.title; }), ['Now', 'All']);
    assert.equal(old[0].items.length, 1, 'a row with items comes with them');
    return items('shows', old[1].id, ana, 2);
  }).then(function (page) {
    assert.deepEqual(page.items.map(function (c) { return c.title; }), ['P2']);
    assert.equal(page.last, true);
  });
});

test('Because you watched, from the history', function () {
  return rowsOf('movies', ana).then(function (rows) {
    var because = rows.filter(function (r) { return r.source === 'core.because'; });
    assert.equal(because.length, 1);
    assert.equal(because[0].id, 'r_movbecause~m949');
    assert.equal(because[0].title, 'Because you watched Heat');
    assert.deepEqual(because[0].items.map(function (t) { return t.tmdbId; }), [807, 862]);
    return items('movies', 'r_movbecause~m949', ana);
  }).then(function (page) {
    assert.equal(page.items.length, 2);
  });
});

test('editing a profile\'s layout: joined plugins, known, single rows, refusals, reset', function () {
  var edited;
  return layout('movies', ana).then(function (l) {
    assert.equal(l.own, false);
    assert.equal(l.custom, false);
    var joined = l.rows.filter(function (e) { return e.new; });
    assert.deepEqual(joined.map(function (e) { return e.params.plugin; }), ['shelf']);
    assert.deepEqual(l.known, ['shelf']);
    // Ana: the shelf's picks (comedy) first, its other rows out, Horror out
    edited = l.rows.filter(function (e) { return !e.new && e.id !== 'r_movhorror'; });
    edited.unshift({ id: 'r_mypicks01', source: 'plugin', params: { plugin: 'shelf', row: 'picks', values: { genre: 'comedy' } } });
    return call('PUT', '/sections/movies/layout?profile=' + ana, { rows: edited, known: l.known });
  }).then(function (r) {
    var l = ok(r);
    conforms('SectionLayout', l);
    assert.equal(l.own, true);
    assert.equal(l.rows.filter(function (e) { return e.new; }).length, 0, 'the shelf is known: it doesn\'t join again');
    return rowsOf('movies', ana);
  }).then(function (rows) {
    assert.equal(rows[0].id, 'r_mypicks01');
    assert.ok(!rows.some(function (r) { return r.id === 'r_movhorror'; }));
    assert.ok(!rows.some(function (r) { return /~paged$/.test(r.id); }), 'taken out with its plugin.all entry');
    return items('movies', 'r_mypicks01', ana);
  }).then(function (page) {
    assert.equal(page.title, 'Picks: comedy', 'the values reach the handler, which may name the row');
    // the plugin.all entry back: it leaves out the offer placed on its own
    edited.push({ id: 'r_shelfall01', source: 'plugin.all', params: { plugin: 'shelf' } });
    return call('PUT', '/sections/movies/layout?profile=' + ana, { rows: edited, known: ['shelf'] });
  }).then(function (r) {
    ok(r);
    return rowsOf('movies', ana);
  }).then(function (rows) {
    assert.deepEqual(rows.filter(function (r) { return r.plugin === 'shelf'; }).map(function (r) { return r.id; }), ['r_mypicks01', 'r_shelfall01~paged']);
    return call('PUT', '/sections/movies/layout?profile=' + ana, { rows: [{ id: 'r_badrow001', source: 'core.list', params: { mediaType: 'tv', list: 'popular' } }] });
  }).then(function (r) {
    assert.equal(r.status, 400);
    assert.match(r.json.error, /tv rows don't go in movies/);
    return call('DELETE', '/sections/movies/layout?profile=' + ana);
  }).then(function (r) {
    var l = ok(r);
    assert.equal(l.own, false);
    assert.ok(l.rows.some(function (e) { return e.id === 'r_movhorror'; }));
  });
});

test('hiding a row keeps it in the layout; labels name every entry and are dropped when sent back', function () {
  return layout('movies', ana).then(function (l) {
    var horror = l.rows.filter(function (e) { return e.id === 'r_movhorror'; })[0],
      shelf = l.rows.filter(function (e) { return e.new; })[0];
    assert.equal(horror.label, 'Horror');
    assert.equal(shelf.label, 'Shelf', 'a joined plugin: its name');
    // sent back as received (labels and all), Horror hidden
    var edited = l.rows.map(function (e) { return e.id === 'r_movhorror' ? Object.assign({}, e, { hidden: true }) : e; });
    return call('PUT', '/sections/movies/layout?profile=' + ana, { rows: edited, known: l.known });
  }).then(function (r) {
    var l = ok(r);
    conforms('SectionLayout', l);
    assert.equal(l.rows.filter(function (e) { return e.id === 'r_movhorror'; })[0].hidden, true);
    return rowsOf('movies', ana);
  }).then(function (rows) {
    assert.ok(!rows.some(function (r) { return r.id === 'r_movhorror'; }), 'not shown');
    return call('PUT', '/sections/movies/layout?profile=' + ana, { rows: [{ id: 'r_movhorror', source: 'core.list', params: { mediaType: 'movie', list: 'popular' }, hidden: 'yes' }] });
  }).then(function (r) {
    assert.equal(r.status, 400);
    assert.match(r.json.error, /hidden must be true or false/);
    return call('DELETE', '/sections/movies/layout?profile=' + ana);
  }).then(ok);
});

test('kids profiles: only the admin changes their rows; the admin\'s default for everyone', function () {
  return call('PUT', '/sections/home/layout?profile=' + kid, { rows: [] }).then(function (r) {
    assert.equal(r.status, 403);
    return call('GET', '/admin/sections/home/layout', undefined, { admin: true });
  }).then(function (r) {
    var l = ok(r);
    conforms('SectionLayout', l);
    assert.equal(l.custom, false);
    var mine = [{ id: 'r_hometop001', source: 'core.list', params: { mediaType: 'tv', list: 'trending' }, title: 'What everyone watches' },
      { id: 'r_homeonly01', source: 'plugin', params: { plugin: 'shelf', row: 'only' } }];
    return call('PUT', '/admin/sections/home/layout', { rows: mine, known: l.known }, { admin: true });
  }).then(function (r) {
    assert.equal(ok(r).custom, true);
    return rowsOf('home', ana);
  }).then(function (rows) {
    assert.deepEqual(rows.map(function (r) { return r.title; }), ['What everyone watches', 'Only offered']);
    return call('PUT', '/admin/sections/home/layout', { rows: 'no' }, { admin: true });
  }).then(function (r) {
    assert.equal(r.status, 400);
    return call('PUT', '/admin/sections/home/layout', { rows: [] });
  }).then(function (r) {
    assert.equal(r.status, 401, 'the admin\'s only');
    return call('DELETE', '/admin/sections/home/layout', undefined, { admin: true });
  }).then(function (r) {
    assert.equal(ok(r).custom, false);
  });
});

test('what the editors can add', function () {
  return call('GET', '/rows/sources?profile=' + ana).then(function (r) {
    var body = ok(r);
    conforms('RowSources', body);
    assert.ok(body.core.some(function (s) { return s.source === 'core.because' && s.expands && s.personal; }));
    var shelf = body.plugins.filter(function (p) { return p.plugin === 'shelf'; })[0];
    assert.deepEqual(shelf.rows.map(function (o) { return o.key; }), ['picks', 'paged', 'only']);
    assert.deepEqual(shelf.rows[0].params[0].options[1], ['comedy', 'Comedy']);
    var old = body.plugins.filter(function (p) { return p.plugin === 'oldrows'; })[0];
    assert.deepEqual(old.slots, ['shows']);
    assert.deepEqual(old.rows, []);
  });
});

test('bad requests', function () {
  return Promise.all([
    call('GET', '/sections/kids/rows').then(function (r) { assert.equal(r.status, 400); }),
    call('GET', '/sections/movies/rows/nope/items').then(function (r) { assert.equal(r.status, 400); }),
    call('GET', '/sections/movies/rows/r_nothing01/items').then(function (r) { assert.equal(r.status, 404); }),
    call('GET', '/sections/movies/rows/r_movtrending/items?page=0').then(function (r) { assert.equal(r.status, 400); }),
    call('GET', '/sections/movies/layout').then(function (r) { assert.equal(r.status, 400, 'a profile is required'); }),
    call('GET', '/sections/movies/rows?profile=nobody').then(function (r) { assert.equal(r.status, 404); })
  ]);
});
