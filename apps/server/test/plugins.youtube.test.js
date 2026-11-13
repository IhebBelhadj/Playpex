'use strict';

// The YouTube plugin (plugins/youtube) and what it relies on in the core:
//   • its server.js in Node with a stub `playpex` and a made-up YouTube Data
//     API (no network): the home rows (trending, categories with a chart only,
//     the linked account's paged rows), search (videos, channels with their
//     subscriber counts, playlists), a channel, a playlist's pages, kids
//     profiles, the API key sent as a header and never in a URL, a quota /
//     key / missing key in words, plays as `embed` sources; every answer
//     against the template schemas;
//   • loaded by a real server from its folder: its play effect leaves as an
//     embed source (id and label only), a bad one is dropped; the embed page
//     is public, static and locked down (CSP with the script's hash);
//   • plugin secrets and linked accounts' tokens are encrypted in the database
//     (lib/secretBox.js), older plain rows sealed when read.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('crypto'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  vm = require('vm');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugin-youtube-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';
// the repo's .env may hold the server's own YouTube credentials: set empty here so dotenv leaves them out
['API_KEY', 'CLIENT_ID', 'CLIENT_SECRET'].forEach(function (k) { process.env['PLAYPEX_PLUGIN_YOUTUBE_' + k] = ''; });

var server = require('..'),
  schemas = require('../lib/plugins/schemas'),
  secretBox = require('../lib/secretBox');

var DIR = path.join(__dirname, '..', '..', '..', 'plugins', 'youtube');
var CHANNEL_A = 'UC' + 'a'.repeat(22), CHANNEL_B = 'UC' + 'b'.repeat(22), CHANNEL_C = 'UC' + 'c'.repeat(22);

// ── a made-up YouTube ───────────────────────────────────────────────────────

function vid(n) {
  return 'vid' + String(n).padStart(8, '0');
}

function videoItem(id, extra) {
  return Object.assign({
    id: id,
    snippet: { title: 'Video ' + id + ' &amp; more', channelTitle: 'Channel A', channelId: CHANNEL_A, publishedAt: '2026-11-01T10:00:00Z', categoryId: '10',
      description: 'About ' + id, liveBroadcastContent: 'none',
      thumbnails: { medium: { url: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' }, high: { url: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' },
        maxres: { url: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg' } } },
    contentDetails: { duration: 'PT1H2M3S' },
    statistics: { viewCount: '1234567' },
    status: { embeddable: true },
    player: { embedWidth: '640', embedHeight: '360' }
  }, extra || {});
}

// Shorts the made-up YouTube serves: a vertical clip of 45 s, one of 2:30, a horizontal "#shorts" of 50 s, and a
// horizontal 2:30 video that isn't one
var SHORTS = {};
SHORTS[vid(801)] = { contentDetails: { duration: 'PT45S' }, player: { embedWidth: '202', embedHeight: '360' } };
SHORTS[vid(802)] = { contentDetails: { duration: 'PT2M30S' }, player: { embedWidth: '202', embedHeight: '360' } };
SHORTS[vid(803)] = { contentDetails: { duration: 'PT50S' } };
var NOT_A_SHORT = vid(804);
function itemOf(id) {
  if (id === NOT_A_SHORT) return videoItem(id, { contentDetails: { duration: 'PT2M30S' } });
  return videoItem(id, SHORTS[id] || (id === vid(500) ? { status: { embeddable: false } } : {}));
}

function fakeYoutube() {
  var y = {
    calls: [],
    fail: null,          // { status, reason }: every call answers it
    answer: function (url, headers) {
      var u = new URL(url), p = u.pathname.replace('/youtube/v3/', ''), q = u.searchParams;
      y.calls.push({ path: p, query: Object.fromEntries(q), key: headers['X-Goog-Api-Key'] || null, auth: headers.Authorization || null });
      if (y.fail) {
        return { status: y.fail.status, body: { error: { code: y.fail.status, message: 'nope', errors: [{ reason: y.fail.reason }] } } };
      }
      if (p === 'videos' && q.get('chart') === 'mostPopular') {
        var cat = q.get('videoCategoryId');
        if (cat && cat !== '10' && cat !== '20') {
          return { status: 404, body: { error: { code: 404, message: 'no chart', errors: [{ reason: 'videoChartNotFound' }] } } };
        }
        // a chart with Shorts in it too
        return { status: 200, body: { items: [1, 2, 3].map(function (n) { return videoItem(vid(n + (cat ? Number(cat) * 10 : 0))); })
          .concat([itemOf(vid(801)), itemOf(vid(803)), itemOf(NOT_A_SHORT)]) } };
      }
      if (p === 'videos' && q.get('myRating') === 'like') {
        return { status: 200, body: { items: [videoItem(vid(900))] } };
      }
      if (p === 'videos' && q.get('id')) {
        return { status: 200, body: { items: q.get('id').split(',').filter(function (id) { return id !== vid(404); }).map(itemOf) } };
      }
      if (p === 'search') {
        return { status: 200, body: { items: [
          { id: { kind: 'youtube#video', videoId: vid(41) }, snippet: { title: 'Found &#39;one&#39;' } },
          { id: { kind: 'youtube#video', videoId: vid(500) }, snippet: { title: 'Not embeddable' } },
          { id: { kind: 'youtube#channel', channelId: CHANNEL_B }, snippet: { title: 'Channel &amp; B', thumbnails: { high: { url: 'https://yt3.ggpht.com/b.jpg' } } } },
          { id: { kind: 'youtube#playlist', playlistId: 'PLabc123' }, snippet: { title: 'A list', channelTitle: 'Channel A', thumbnails: { high: { url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' } } } }
        ] } };
      }
      if (p === 'channels') {
        return { status: 200, body: { items: q.get('id').split(',').map(function (id) {
          return { id: id, snippet: { title: id === CHANNEL_A ? 'Channel A' : 'Channel B', description: 'A channel', thumbnails: { high: { url: 'https://yt3.ggpht.com/' + id + '.jpg' } } },
            statistics: { subscriberCount: '2500000', hiddenSubscriberCount: false } };
        }) } };
      }
      if (p === 'playlists') {
        return { status: 200, body: { items: [{ id: q.get('id') || 'PLmine1', snippet: { title: 'My list', channelTitle: 'Channel A', description: 'Songs',
          thumbnails: { high: { url: 'https://i.ytimg.com/vi/y/hqdefault.jpg' } } }, contentDetails: { itemCount: 2 } }] } };
      }
      if (p === 'playlistItems') {
        // channel B has no long-videos list (UULF…): its whole uploads (UU…) instead
        if (q.get('playlistId') === 'UULF' + CHANNEL_B.slice(2)) {
          return { status: 404, body: { error: { code: 404, message: 'no such list', errors: [{ reason: 'playlistNotFound' }] } } };
        }
        var page = q.get('pageToken') === 'p2' ? 2 : 1, base = q.get('playlistId') === 'UULF' + CHANNEL_A.slice(2) || q.get('playlistId') === 'UU' + CHANNEL_A.slice(2) ? 700 : 600;
        return { status: 200, body: {
          nextPageToken: page === 1 ? 'p2' : undefined,
          items: [1, 2].map(function (n) { return { contentDetails: { videoId: vid(base + page * 10 + n), videoPublishedAt: '2026-11-0' + n + 'T00:00:00Z' } }; })
            .concat(page === 1 ? [{ contentDetails: { videoId: vid(404) } }, { contentDetails: { videoId: vid(802) } }] : [])
        } };
      }
      if (p === 'subscriptions') {
        // as YouTube answers: the item's own id is the subscription's, its channel is resourceId; a second page
        var second = q.get('pageToken') === 's2';
        return { status: 200, body: { nextPageToken: second ? undefined : 's2', items: (second ? [CHANNEL_C] : [CHANNEL_A, CHANNEL_B]).map(function (id) {
          return { kind: 'youtube#subscription', id: 'sub-' + id.slice(2, 12) + 'xyzXYZ0123456789',
            snippet: { title: 'Channel ' + id.charAt(2).toUpperCase(), resourceId: { kind: 'youtube#channel', channelId: id },
              thumbnails: { high: { url: 'https://yt3.ggpht.com/' + id + '.jpg' } } } };
        }) } };
      }
      return { status: 404, body: { error: { code: 404, message: 'not here', errors: [{ reason: 'notFound' }] } } };
    }
  };
  return y;
}

// ── the plugin in Node ──────────────────────────────────────────────────────

function load(options) {
  options = options || {};
  var p = {
    handlers: {},
    secrets: 'secrets' in options ? options.secrets : { apiKey: 'key-123' },
    server: Object.assign({ region: 'US', kids: 'off' }, options.server || {}),
    links: options.links || {},
    store: options.store || {},
    yt: fakeYoutube()
  };
  var plain = function (v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); };
  var playpex = {
    data: function (name, fn) { p.handlers[name] = function (args, ctx) { return Promise.resolve(fn(args || {}, ctx)).then(plain); }; },
    http: {
      request: function (o) {
        assert.ok(/^https:\/\/www\.googleapis\.com\/youtube\/v3\//.test(o.url), o.url);
        assert.ok(!/key=/.test(o.url), 'no key in a URL: ' + o.url);
        var r = p.yt.answer(o.url, o.headers || {});
        return Promise.resolve({ status: r.status, headers: {}, body: r.body });
      }
    },
    secrets: { get: function (k) { return Promise.resolve(p.secrets[k] || null); } },
    settings: { get: function (k) { return Promise.resolve(p.server[k]); } },
    store: {
      get: function (k) { return Promise.resolve(k in p.store ? plain(p.store[k]) : null); },
      set: function (k, v) { p.store[k] = plain(v); return Promise.resolve(true); }
    },
    link: { status: function (name, id) { assert.equal(name, 'google'); return Promise.resolve(p.links[id] ? { linked: true, accessToken: p.links[id] } : { linked: false }); } },
    log: { warn: function () {}, info: function () {}, error: function () {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(DIR, 'server.js'), 'utf8'), { playpex: playpex, URL: URL, encodeURIComponent: encodeURIComponent, String: String });
  return p;
}

var ANA = { profile: { id: 'ana', kids: false }, device: null, locale: 'en-US' };
var KID = { profile: { id: 'kid', kids: true }, device: null, locale: 'en' };

function valid(def, value) {
  var problem = schemas.apiProblem(def, value);
  assert.equal(problem, null, def + ': ' + problem + '\n' + JSON.stringify(value).slice(0, 600));
}

function rowKeys(data) {
  return data.rows.map(function (r) { return r.key; });
}

test('home, Trending view: trending and the categories that have a chart there, video cards with their info', function () {
  var p = load();
  return p.handlers.home({ params: {}, query: '', filters: { view: ['trending'] } }, ANA).then(function (r) {
    valid('templates/properties/catalog', r.data);
    // then the channels of those videos: a way to their pages
    assert.deepEqual(rowKeys(r.data), ['youtube:trending', 'youtube:cat10', 'youtube:cat20', 'youtube:channels-here']);
    assert.equal(r.data.rows[3].variant, 'portrait');
    var card = r.data.rows[0].items[0];
    assert.equal(card.variant, 'still');
    assert.equal(card.title, 'Video ' + vid(1) + ' & more');
    assert.equal(card.image, 'https://i.ytimg.com/vi/' + vid(1) + '/hqdefault.jpg');
    assert.deepEqual(card.badges, [{ text: '1:02:03' }]);
    assert.match(card.subtitle, /^Channel A · 1\.2M views · \d+ (day|week)s? ago$/);
    assert.deepEqual(card.call, { data: 'play', args: { id: vid(1), title: card.title, channel: 'Channel A', embeddable: true, channelId: CHANNEL_A, categoryId: '10' } });
    // the filters: View (Trending on) and Category
    assert.deepEqual(r.data.filters.map(function (f) { return f.key; }), ['view', 'category']);
    assert.ok(r.data.filters.every(function (f) { return f.button === true; }), 'each its own toolbar button');
    assert.equal(r.data.filters[0].options.filter(function (o) { return o.on; })[0].value, 'trending');
    assert.equal(card.info.backdrop, 'https://i.ytimg.com/vi/' + vid(1) + '/maxresdefault.jpg');
    assert.equal(r.data.search, true);
    // the key as a header, the region asked
    assert.ok(p.yt.calls.every(function (c) { return c.key === 'key-123' && c.auth === null; }));
    assert.ok(p.yt.calls.every(function (c) { return c.path === 'channels' || c.query.regionCode === 'US'; }));
    // cached: the screen again asks nothing
    var before = p.yt.calls.length;
    return p.handlers.home({ params: {}, query: '', filters: { view: ['trending'] } }, ANA).then(function () {
      assert.equal(p.yt.calls.length, before);
    });
  });
});

test('views of a linked account: subscriptions (latest, channels, a row per channel), liked by category, playlists', function () {
  var p = load({ links: { ana: 'token-ana' } });
  return Promise.all(['subscriptions', 'liked', 'playlists'].map(function (view) {
    return p.handlers.home({ query: '', filters: { view: [view] } }, ANA);
  })).then(function (r) {
    r.forEach(function (x) { valid('templates/properties/catalog', x.data); });
    var subs = rowKeys(r[0].data);
    assert.deepEqual(subs.slice(0, 2), ['youtube:subs-latest', 'youtube:subs-channels']);
    assert.ok(subs.indexOf('youtube:subs-' + CHANNEL_A) !== -1);
    // the feed: the subscriptions' uploads (UU…), newest first, a removed video left out
    var feed = r[0].data.rows[0].items.map(function (c) { return c.key; });
    assert.equal(feed[0], 'youtube:v:' + vid(712));
    assert.ok(feed.indexOf('youtube:v:' + vid(404)) === -1);
    assert.deepEqual(r[0].data.rows[1].items[0].intent, { screen: 'plugin.youtube.channel', params: { id: CHANNEL_A } });
    // every subscription, the second page too, by the channel's id (never the subscription's)
    assert.deepEqual(r[0].data.rows[1].items.map(function (c) { return c.key; }), [CHANNEL_A, CHANNEL_B, CHANNEL_C].map(function (id) { return 'youtube:c:' + id; }));
    // liked: all of them, then their channels (a way to their pages)
    assert.deepEqual(rowKeys(r[1].data), ['youtube:liked-all', 'youtube:channels-here']);
    assert.deepEqual(r[1].data.rows[1].items.map(function (c) { return c.intent.params.id; }), [CHANNEL_A]);
    assert.deepEqual(r[1].data.rows[0].page, { data: 'page', args: { list: 'liked' } });
    assert.deepEqual(rowKeys(r[2].data), ['youtube:playlists', 'youtube:playlist-PLmine1']);
    return Promise.all([p.handlers.page({ list: 'liked', page: 1 }, ANA), p.handlers.page({ list: 'liked', page: 1, category: '20' }, ANA)]);
  }).then(function (pages) {
    valid('rowPage', pages[0].data);
    assert.equal(pages[0].data.items[0].key, 'youtube:v:' + vid(900));
    assert.deepEqual(pages[1].data.items, [], 'a category without liked videos');
    // the account's calls carry its token; nothing else does
    p.yt.calls.forEach(function (c) {
      var mine = c.query.mine === 'true' || c.query.myRating === 'like' || c.path === 'playlistItems' || (c.path === 'videos' && c.query.id);
      assert.equal(c.auth, mine ? 'Bearer token-ana' : null, c.path + ' ' + JSON.stringify(c.query));
    });
    // without a linked account those views say how to get one
    return p.handlers.home({ query: '', filters: { view: ['liked'] } }, { profile: { id: 'bob', kids: false }, locale: 'en' });
  }).then(function (r) {
    assert.deepEqual(r.data.rows, []);
    assert.match(r.data.empty, /Link a Google account/);
  });
});

test('For you: made from what the profile played and liked, without what it already saw; a category narrows it', function () {
  var hist = [{ id: vid(1), title: 'Lo-fi beats to study [Official Video] | Channel A', channelId: CHANNEL_A, categoryId: '10', at: new Date().toISOString() }];
  var p = load({ links: { ana: 'token-ana' }, store: { 'history:ana': hist } });
  return p.handlers.home({ query: '', filters: {} }, ANA).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.equal(r.data.filters[0].options.filter(function (o) { return o.on; })[0].value, 'foryou', 'For you is the default view');
    var keys = rowKeys(r.data);
    assert.equal(keys[0], 'youtube:foryou');
    assert.ok(keys.indexOf('youtube:because') !== -1, keys.join());
    assert.ok(keys.indexOf('youtube:more-' + CHANNEL_A) !== -1, keys.join());
    assert.ok(keys.indexOf('youtube:popular-10') !== -1, keys.join());
    var all = [].concat.apply([], r.data.rows.map(function (x) { return x.items.map(function (c) { return c.key; }); }));
    assert.ok(all.indexOf('youtube:v:' + vid(1)) === -1, 'what it played is left out');
    assert.ok(all.indexOf('youtube:v:' + vid(900)) === -1, 'what it liked is left out');
    var search = p.yt.calls.filter(function (c) { return c.path === 'search'; })[0];
    assert.equal(search.query.q, 'Lo fi beats to study', 'the last play\'s title, its brackets and channel cut');
    assert.equal(search.query.type, 'video');
    // a category: only its videos
    return p.handlers.home({ query: '', filters: { category: ['20'] } }, ANA);
  }).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.match(r.data.rows[0].title, /Trending in Gaming/, 'nothing of it watched yet: its chart');
  });
});

test('For you with nothing to go on: the charts, saying it learns from what you watch; a play is remembered', function () {
  var p = load();
  return p.handlers.home({ query: '', filters: {} }, ANA).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.match(r.data.rows[0].title, /^Trending · For you learns from what you watch$/);
    return p.handlers.play({ id: vid(5), title: 'Five', channel: 'Channel A', embeddable: true, channelId: CHANNEL_A, categoryId: '10' }, ANA);
  }).then(function () {
    assert.deepEqual(p.store['history:ana'].map(function (h) { return [h.id, h.channelId, h.categoryId]; }), [[vid(5), CHANNEL_A, '10']]);
    return p.handlers.play({ id: vid(5), title: 'Five', channelId: 'nope' }, ANA);
  }).then(function () {
    assert.equal(p.store['history:ana'].length, 1, 'once per video');
    assert.equal(p.store['history:ana'][0].channelId, null, 'a bad channel id isn\'t kept');
  });
});

test('search: videos, channels with their subscribers, playlists; a video its owner keeps on YouTube says so', function () {
  var p = load();
  return p.handlers.home({ query: '  cats ' }, ANA).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.deepEqual(rowKeys(r.data), ['youtube:search-videos', 'youtube:search-channels', 'youtube:search-playlists']);
    var search = p.yt.calls.filter(function (c) { return c.path === 'search'; })[0];
    assert.equal(search.query.q, 'cats');
    assert.equal(search.query.safeSearch, 'moderate');
    var channel = r.data.rows[1].items[0];
    assert.equal(channel.title, 'Channel B');
    assert.equal(channel.subtitle, '2.5M subscribers');
    assert.equal(r.data.rows[2].items[0].title, 'A list');
    var blocked = r.data.rows[0].items[1];
    assert.equal(blocked.call.args.embeddable, false);
    return p.handlers.play(blocked.call.args, ANA);
  }).then(function (r) {
    valid('dataAnswer', r);
    assert.equal(r.effects[0].type, 'toast');
    // the search page's chip: the same rows
    return p.handlers.searchFilter({ slot: 'core.search.filters', context: { query: 'cats' } }, ANA);
  }).then(function (r) {
    valid('slots/searchFilter', r.data);
    assert.equal(r.data.chip.label, 'YouTube');
    assert.equal(r.data.rows.length, 3);
    assert.equal(p.yt.calls.filter(function (c) { return c.path === 'search'; }).length, 1, 'a search is asked once an hour');
  });
});

test('a card plays as an embed source: the video id and its title, nothing remembered', function () {
  var p = load();
  return p.handlers.play({ id: vid(1), title: 'A video', channel: 'Channel A', embeddable: true }, ANA).then(function (r) {
    valid('dataAnswer', r);
    assert.deepEqual(r.effects, [{ type: 'play', request: { title: 'A video', subtitle: 'Channel A', tracking: 'none',
      sources: [{ kind: 'embed', provider: 'youtube', id: vid(1), label: 'A video' }] } }]);
    return p.handlers.play({ id: '../../etc' }, ANA);
  }).then(function (r) {
    assert.equal(r.effects[0].type, 'toast');
  });
});

test('channel and playlist screens: uploads and a playlist page by page', function () {
  var p = load();
  return p.handlers.channel({ params: { id: CHANNEL_A }, query: '' }, ANA).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.equal(r.data.title, 'Channel A · 2.5M subscribers');
    // its videos together: long ones, Shorts, live streams (YouTube's own lists), then its playlists
    assert.deepEqual(r.data.rows.map(function (x) { return x.page ? x.page.args.id : x.key; }),
      ['UULF', 'UUSH', 'UULV'].map(function (pre) { return pre + CHANNEL_A.slice(2); }).concat(['youtube:channel-playlists']));
    assert.deepEqual(r.data.rows.slice(0, 3).map(function (x) { return x.title; }), ['Videos', 'Shorts', 'Live streams']);
    return p.handlers.page({ list: 'playlist', id: 'UU' + CHANNEL_A.slice(2), page: 1 }, ANA);
  }).then(function (r) {
    valid('rowPage', r.data);
    assert.deepEqual(r.data.items.map(function (c) { return c.key; }), ['youtube:v:' + vid(711), 'youtube:v:' + vid(712), 'youtube:v:' + vid(802)],
      'its uploads, its Short too (a removed video left out)');
    assert.equal(r.data.last, false);
    return p.handlers.page({ list: 'playlist', id: 'UU' + CHANNEL_A.slice(2), page: 2 }, ANA);
  }).then(function (r) {
    assert.deepEqual(r.data.items.map(function (c) { return c.key; }), ['youtube:v:' + vid(721), 'youtube:v:' + vid(722)]);
    assert.equal(r.data.last, true);
    var second = p.yt.calls.filter(function (c) { return c.path === 'playlistItems'; }).pop();
    assert.equal(second.query.pageToken, 'p2');
    return Promise.all([
      p.handlers.playlist({ params: { id: 'PLabc123' } }, ANA),
      p.handlers.channel({ params: { id: 'not-a-channel' } }, ANA),
      p.handlers.page({ list: 'playlist', id: 'x y', page: 1 }, ANA)
    ]);
  }).then(function (r) {
    valid('templates/properties/catalog', r[0].data);
    assert.equal(r[0].data.title, 'My list');
    assert.deepEqual(r[1].data.rows, []);
    assert.deepEqual(r[2].data, { items: [], last: true });
  });
});

test('Channels view: subscriptions A to Z, the channels the profile watches here; a list a channel lacks is an empty row', function () {
  var hist = [{ id: vid(1), title: 'x', channelId: CHANNEL_B, categoryId: '10', at: new Date().toISOString() },
    { id: vid(2), title: 'y', channelId: 'UC' + 'd'.repeat(22), categoryId: '10', at: new Date().toISOString() }];
  var p = load({ links: { ana: 'token-ana' }, store: { 'history:ana': hist } });
  return p.handlers.home({ query: '', filters: { view: ['channels'] } }, ANA).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.equal(r.data.filters[0].options.filter(function (o) { return o.on; })[0].value, 'channels');
    // watched without subscribing (B is a subscription: left out of that row), then every subscription
    assert.deepEqual(rowKeys(r.data), ['youtube:channels-watched', 'youtube:subs-all-0']);
    assert.deepEqual(r.data.rows[0].items.map(function (c) { return c.intent.params.id; }), ['UC' + 'd'.repeat(22)]);
    assert.equal(r.data.rows[1].title, 'Your subscriptions');
    assert.equal(r.data.rows[1].items.length, 3);
    // without an account: only what it watched (none here), and how to link one
    return p.handlers.home({ query: '', filters: { view: ['channels'] } }, { profile: { id: 'bob', kids: false }, locale: 'en' });
  }).then(function (r) {
    assert.deepEqual(r.data.rows, []);
    assert.match(r.data.empty, /Link a Google account/);
    // many subscriptions: rows of 40 named by letters
    var sandbox = { module: { exports: {} }, playpex: { data: function () {} } };
    vm.runInNewContext(fs.readFileSync(path.join(DIR, 'server.js'), 'utf8'), sandbox);
    var y = sandbox.module.exports;
    var many = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')).sort().map(function (l, i) {
      return { id: 'UC' + String(i).padStart(22, '0'), title: l + ' channel' };
    });
    var rows = y.letterRows('subs-all', many);
    assert.deepEqual(JSON.parse(JSON.stringify(rows.map(function (x) { return x.title + ':' + x.items.length; }))), ['A – T:40', 'U – Z:12']);
    // a subscription item: its channel is resourceId, not its own id
    assert.equal(y.channelOf({ id: 'subscription-id', snippet: { resourceId: { channelId: CHANNEL_A } } }).id, CHANNEL_A);
    // a channel without Shorts: the row's page is empty, not a failure
    p.yt.fail = { status: 404, reason: 'playlistNotFound' };
    return p.handlers.page({ list: 'playlist', id: 'UUSH' + CHANNEL_B.slice(2), page: 1 }, ANA);
  }).then(function (r) {
    assert.deepEqual(r.data, { items: [], last: true });
  });
});

test('kids profiles: off by default; "search only" searches with SafeSearch strict and shows no charts', function () {
  var p = load();
  return p.handlers.home({ query: '' }, KID).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.deepEqual(r.data.rows, []);
    assert.match(r.data.empty, /off for kids/);
    assert.equal(p.yt.calls.length, 0);
    var q = load({ server: { kids: 'search' } });
    return q.handlers.home({ query: '' }, KID).then(function (home) {
      assert.deepEqual(home.data.rows, []);
      assert.equal(q.yt.calls.length, 0);
      return q.handlers.home({ query: 'dinosaurs' }, KID);
    }).then(function (found) {
      valid('templates/properties/catalog', found.data);
      assert.equal(q.yt.calls.filter(function (c) { return c.path === 'search'; })[0].query.safeSearch, 'strict');
    });
  });
});

test('no key, a used-up quota, a refused key: said in words, nothing breaks', function () {
  var none = load({ secrets: {} });
  return none.handlers.home({ query: '' }, ANA).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.match(r.data.empty, /no YouTube API key yet/);
    assert.equal(none.yt.calls.length, 0);
    var quota = load();
    quota.yt.fail = { status: 403, reason: 'quotaExceeded' };
    return quota.handlers.home({ query: '' }, ANA);
  }).then(function (r) {
    assert.match(r.data.empty, /quota/);
    var bad = load();
    bad.yt.fail = { status: 400, reason: 'keyInvalid' };
    return bad.handlers.home({ query: 'x' }, ANA);
  }).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.match(r.data.empty, /refused this server's API key/);
  });
});

test('Shorts: shown where people browse (marked Short), never recommended in For you', function () {
  var hist = [{ id: vid(1), title: 'Something good to watch', channelId: CHANNEL_A, categoryId: '10', at: new Date().toISOString() }];
  var p = load({ links: { ana: 'token-ana' }, store: { 'history:ana': hist } });
  function keysOf(rows) {
    return [].concat.apply([], rows.map(function (x) { return (x.items || []).map(function (c) { return c.key; }); }));
  }
  return Promise.all([
    p.handlers.home({ query: '', filters: { view: ['trending'] } }, ANA),
    p.handlers.page({ list: 'playlist', id: 'UU' + CHANNEL_A.slice(2), page: 1 }, ANA),
    p.handlers.home({ query: '', filters: {} }, ANA)
  ]).then(function (r) {
    // browsing: the Shorts are there, marked
    var trending = r[0].data.rows[0].items;
    var short = trending.filter(function (c) { return c.key === 'youtube:v:' + vid(801); })[0];
    assert.ok(short, 'a Short in Trending');
    assert.deepEqual(short.badges, [{ text: 'Short' }]);
    assert.ok(short.info.meta.some(function (m) { return m.kind === 'chip' && /^Short · 0:45$/.test(m.text); }));
    assert.ok(r[1].data.items.some(function (c) { return c.key === 'youtube:v:' + vid(802); }), 'a channel\'s uploads keep their Shorts');
    // For you: none
    var forYou = keysOf(r[2].data.rows);
    assert.ok(forYou.length > 0);
    [801, 802, 803].forEach(function (n) { assert.ok(forYou.indexOf('youtube:v:' + vid(n)) === -1, vid(n) + ' is a Short: not recommended'); });
    assert.ok(forYou.indexOf('youtube:v:' + NOT_A_SHORT) !== -1, 'a short horizontal video is no Short');
    // For you reads the channels' long-videos lists, the whole uploads for a channel without one
    var lists = p.yt.calls.filter(function (c) { return c.path === 'playlistItems'; }).map(function (c) { return c.query.playlistId; });
    assert.ok(lists.indexOf('UULF' + CHANNEL_A.slice(2)) !== -1, lists.join());
    assert.ok(p.yt.calls.filter(function (c) { return c.path === 'videos'; }).every(function (c) { return /player/.test(c.query.part) && c.query.maxHeight === '360'; }));
    // with nothing to go on, For you's charts have no Shorts either
    var fresh = load();
    return fresh.handlers.home({ query: '', filters: {} }, ANA);
  }).then(function (r) {
    var keys = keysOf(r.data.rows);
    assert.ok(keys.length > 0);
    [801, 803].forEach(function (n) { assert.ok(keys.indexOf('youtube:v:' + vid(n)) === -1); });
  });
});

test('the pure parts: durations, counts, entities', function () {
  var sandbox = { module: { exports: {} }, playpex: { data: function () {} } };
  vm.runInNewContext(fs.readFileSync(path.join(DIR, 'server.js'), 'utf8'), sandbox);
  var m = sandbox.module.exports;
  assert.equal(m.seconds('PT4M13S'), 253);
  assert.equal(m.seconds('P1DT1S'), 86401);
  assert.equal(m.seconds('nope'), 0);
  assert.equal(m.clock(253), '4:13');
  assert.equal(m.clock(3723), '1:02:03');
  assert.equal(m.count(1, 'view'), '1 view');
  assert.equal(m.count(15300, 'view'), '15K views');
  assert.equal(m.count(1000000, 'view'), '1M views');
  assert.equal(m.unescape('Tom &amp; Jerry &#39;n&#x27; &quot;co&quot;'), 'Tom & Jerry \'n\' "co"');
});

// ── secrets at rest ─────────────────────────────────────────────────────────

test('secretBox: sealed with a random IV, opened back, another key or a tampered value opens to null', function () {
  var key = crypto.randomBytes(32), box = secretBox.createBox(key);
  var a = box.seal('token-1'), b = box.seal('token-1');
  assert.ok(a.indexOf('enc:v1:') === 0 && a !== b);
  assert.ok(a.indexOf('token-1') === -1);
  assert.equal(box.open(a), 'token-1');
  assert.equal(box.open('plain, from before'), 'plain, from before');
  assert.equal(secretBox.createBox(crypto.randomBytes(32)).open(a), null);
  var parts = a.split('.');
  parts[2] = Buffer.from('xxxx').toString('base64url');
  assert.equal(box.open(parts.join('.')), null);
});

// ── a real server ───────────────────────────────────────────────────────────

var base = null;

function request(method, url, body) {
  return new Promise(function (resolve, reject) {
    var u = new URL(base + url),
      data = body ? JSON.stringify(body) : null;
    var req = http.request({ method: method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: Object.assign({ 'X-Playpex-Device': 'device-test' }, data ? { 'Content-Type': 'application/json' } : {}) }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8'), json = null;
        try { json = JSON.parse(text); } catch (e) { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, text: text, body: json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('loaded by a real server: play effects leave as embed sources; the embed page is public and locked down', function () {
  var plugins = require('../lib/plugins');
  return server.start({ port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false },
    plugins: { dirs: [DIR], installed: false, repositories: false } }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    var until = Date.now() + 20000;
    return new Promise(function (resolve, reject) {
      (function poll() {
        var found = plugins.get('youtube');
        if (found && found.state !== 'loading') return resolve(found);
        if (Date.now() > until) return reject(new Error('not loaded'));
        setTimeout(poll, 50);
      })();
    });
  }).then(function (plugin) {
    assert.equal(plugin.state, 'enabled', plugin.error || '');
    return request('POST', '/api/v1/plugins/youtube/data/play', { args: { id: vid(7), title: 'Seven', channel: 'Channel A', embeddable: true } });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.effects[0].request.sources, [{ kind: 'embed', provider: 'youtube', id: vid(7), label: 'Seven' }]);
    // without a key, home says what the admin should do
    return request('POST', '/api/v1/plugins/youtube/data/home', { args: { params: {}, query: '', filters: {} } });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.match(r.body.data.empty, /no YouTube API key yet/);
    // the server's environment provides one: the plugin reads it (and Google is asked: here it fails, no network)
    process.env.PLAYPEX_PLUGIN_YOUTUBE_API_KEY = 'env-key';
    return require('../lib/plugins/settings').view('youtube', 'en');
  }).then(function (view) {
    assert.equal(view.secrets.apiKey, true, 'shown as set on the dashboard');
    assert.equal(view.secrets.clientId, false);
    return request('POST', '/api/v1/plugins/youtube/data/home', { args: { params: {}, query: '', filters: {} } });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.doesNotMatch(r.body.data.empty || '', /no YouTube API key yet/, 'the environment\'s key is used');
    process.env.PLAYPEX_PLUGIN_YOUTUBE_API_KEY = '';
    // the embed page: no auth, static, its script allowed by hash only
    return request('GET', '/api/v1/embed/youtube?v=' + vid(7) + '&start=30');
  }).then(function (r) {
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    var csp = r.headers['content-security-policy'];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+' https:\/\/www\.youtube\.com/);
    assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.ok(r.text.indexOf(vid(7)) === -1, 'nothing of the request is written into the page');
    var script = /<script>([\s\S]*)<\/script>/.exec(r.text)[1];
    assert.ok(csp.indexOf("'sha256-" + crypto.createHash('sha256').update(script).digest('base64') + "'") !== -1);
    assert.match(r.text, /youtube-nocookie\.com/);
  });
});

test('envSecrets: a plugin secret\'s default from the environment; the admin\'s value wins', function () {
  var env = require('../lib/plugins/envSecrets');
  assert.equal(env.variable('youtube', 'apiKey'), 'PLAYPEX_PLUGIN_YOUTUBE_API_KEY');
  assert.equal(env.variable('my-plugin', 'clientSecret'), 'PLAYPEX_PLUGIN_MY_PLUGIN_CLIENT_SECRET');
  process.env.PLAYPEX_PLUGIN_YOUTUBE_CLIENT_ID = ' env-client ';
  try {
    assert.equal(env.get('youtube', 'clientId'), 'env-client');
    assert.equal(env.orDefault('youtube', 'clientId', null), 'env-client');
    assert.equal(env.orDefault('youtube', 'clientId', 'admin-client'), 'admin-client');
    assert.ok(env.get('youtube', 'clientSecret') === null, 'an empty variable is none');
  } finally {
    process.env.PLAYPEX_PLUGIN_YOUTUBE_CLIENT_ID = '';
  }
});

test('plugin secrets and linked tokens are encrypted in the database; plain rows from before are sealed when read', function () {
  var userData = require('../lib/userData');
  return userData.services().then(function (services) {
    return services.plugins.secrets.set('youtube', 'apiKey', 'key-xyz').then(function () {
      return userData.database();
    }).then(function (db) {
      var data = require('../lib/data').createRepositories(db);
      return data.plugins.secretGet('youtube', 'apiKey', '').then(function (stored) {
        assert.ok(stored.indexOf('enc:v1:') === 0, stored);
        assert.ok(stored.indexOf('key-xyz') === -1);
        return services.plugins.secrets.get('youtube', 'apiKey');
      }).then(function (value) {
        assert.equal(value, 'key-xyz');
        // a row written before secrets were encrypted
        return data.plugins.secretSet('youtube', 'link:google', 'ana', '{"accessToken":"old"}', new Date());
      }).then(function () {
        return services.plugins.secrets.get('youtube', 'link:google', 'ana');
      }).then(function (value) {
        assert.equal(value, '{"accessToken":"old"}');
        return data.plugins.secretGet('youtube', 'link:google', 'ana');
      }).then(function (stored) {
        assert.ok(stored.indexOf('enc:v1:') === 0, 'sealed once read');
        var keyFile = path.join(process.env.PLAYPEX_CONFIG_DIR, 'secrets.key');
        assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
      });
    });
  });
});

test.after(function () {
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
