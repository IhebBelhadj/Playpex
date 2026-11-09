// YouTube for Playpex (plugins/youtube): browsing with the YouTube Data API v3
// (the admin's API key, its secret `apiKey`), a linked Google account per
// profile for its subscriptions, liked videos and playlists (device code,
// read-only scope; the host keeps and refreshes the tokens), and videos played
// as `embed` sources: YouTube's own IFrame player in the client, under the
// client's controls (SERVER_PLUGIN_API 1.3).
//
// Screens (catalog template):
//   home       Trending and category rows (the region's charts; cached 30 min),
//              with a linked account first its rows (paged rows: each loads on
//              its own); a search → videos, channels, playlists
//   channel    a channel's uploads (paged) and playlists         params { id }
//   playlist   a playlist's videos (paged)                       params { id }
// Data handlers: home, channel, playlist, page (paged rows), play (a card's
// call → a play effect), searchFilter (the search page's chip).
//
// Quota (10,000 units a day per key): a list call costs 1, a search 100. Rows
// are cached in memory (30 min, a search 1 h); the subscriptions feed reads at
// most 10 channels' uploads (1 unit each).

var API = 'https://www.googleapis.com/youtube/v3/';
var ID = /^[A-Za-z0-9_-]{11}$/;
var CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
var LIST = /^[A-Za-z0-9_-]{2,64}$/;
var FEED_CHANNELS = 10;

// the category rows, in order (YouTube's ids); a category without a chart in the region is left out
var CATEGORIES = [
  ['10', 'Music'], ['20', 'Gaming'], ['17', 'Sports'], ['25', 'News & politics'], ['24', 'Entertainment'],
  ['23', 'Comedy'], ['28', 'Science & technology'], ['1', 'Film & animation'], ['26', 'How-to & style'], ['27', 'Education']
];

// ── small helpers ───────────────────────────────────────────────────────────

function clip(text, n) {
  text = String(text == null ? '' : text);
  return text.length > n ? text.slice(0, n - 1) + '…' : text;
}

// search.list answers titles with HTML entities
function unescape(text) {
  return String(text || '').replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, function (m, e) {
    var lower = e.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return '\'';
    var code = lower.charAt(1) === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
}

/** ISO 8601 duration (PT1H2M3S) → seconds */
function seconds(iso) {
  var m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso || ''));
  if (!m) return 0;
  return (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (Number(m[4]) || 0);
}

function clock(s) {
  if (!s) return '';
  var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  function two(n) { return (n < 10 ? '0' : '') + n; }
  return h ? h + ':' + two(m) + ':' + two(sec) : m + ':' + two(sec);
}

function count(n, unit) {
  n = Number(n);
  if (!isFinite(n) || n < 0) return '';
  var text = n >= 1e9 ? (n / 1e9).toFixed(n < 1e10 ? 1 : 0) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'K' : String(n);
  return text.replace('.0', '') + ' ' + unit + (n === 1 ? '' : 's');
}

function ago(date, now) {
  var t = Date.parse(date);
  if (!isFinite(t)) return '';
  var s = Math.max(0, ((now || Date.now()) - t) / 1000);
  var steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month']];
  var unit = 'second', n = s;
  for (var i = 0; i < steps.length; i++) {
    if (n < steps[i][0]) {
      unit = steps[i][1];
      break;
    }
    n /= steps[i][0];
    unit = i + 1 < steps.length ? steps[i + 1][1] : 'year';
  }
  n = Math.floor(n);
  if (unit === 'second') return 'just now';
  return n + ' ' + unit + (n === 1 ? '' : 's') + ' ago';
}

/** the largest picture up to `max` (default, medium, high, standard, maxres) */
function thumb(thumbs, max) {
  var order = ['maxres', 'standard', 'high', 'medium', 'default'];
  thumbs = thumbs || {};
  for (var i = order.indexOf(max || 'high'); i < order.length; i++) {
    var t = thumbs[order[i]];
    if (t && /^https:\/\//.test(t.url)) return t.url;
  }
  return null;
}

// ── the API ─────────────────────────────────────────────────────────────────

function problem(reason, message) {
  var err = new Error(message);
  err.reason = reason;
  return err;
}

/** What to tell people when a call failed (the screen's empty state) */
function explain(err) {
  switch (err && err.reason) {
    case 'nokey': return 'This server has no YouTube API key yet: its admin sets PLAYPEX_PLUGIN_YOUTUBE_API_KEY, or a key in Plugins › YouTube › Settings.';
    case 'quota': return 'YouTube\'s daily quota for this server\'s API key is used up. It starts again at midnight Pacific time.';
    case 'key': return 'YouTube refused this server\'s API key. The admin can check it on the dashboard (Plugins › YouTube › Settings).';
    case 'auth': return 'The linked Google account needs linking again (dashboard › Plugins › YouTube › Accounts).';
    default: return 'YouTube didn\'t answer. Try again in a moment.';
  }
}

/** GET <API><path>; `token`: a linked account's access token */
function yt(path, params, token) {
  return playpex.secrets.get('apiKey').then(function (key) {
    if (!key && !token) throw problem('nokey', 'no API key');
    var query = Object.keys(params || {}).filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    var headers = { Accept: 'application/json' };
    // the key as a header, never in the URL (URLs end up in logs)
    if (key) headers['X-Goog-Api-Key'] = key;
    if (token) headers.Authorization = 'Bearer ' + token;
    return playpex.http.request({ url: API + path + (query ? '?' + query : ''), headers: headers, responseType: 'json', timeoutMs: 8000 });
  }).then(function (r) {
    if (r.status >= 200 && r.status < 300 && r.body) return r.body;
    var e = r.body && r.body.error, reason = e && e.errors && e.errors[0] && e.errors[0].reason;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded') throw problem('quota', reason);
    if (r.status === 401) throw problem('auth', 'HTTP 401');
    if (reason === 'keyInvalid' || reason === 'accessNotConfigured' || reason === 'ipRefererBlocked' || (r.status === 400 && /API key/i.test(e && e.message || ''))) throw problem('key', reason || 'key');
    if (r.status === 404) throw problem('notFound', reason || 'HTTP 404');
    throw problem('upstream', 'HTTP ' + r.status + (reason ? ' ' + reason : ''));
  });
}

// what was read lately, in memory (the sandbox lives until the plugin reloads)
var cache = {};
function cached(key, ttlMs, make) {
  var hit = cache[key];
  if (hit && hit.until > Date.now()) return hit.value;
  var value = make().then(function (v) { return v; }, function (err) {
    delete cache[key];
    throw err;
  });
  cache[key] = { until: Date.now() + ttlMs, value: value };
  // keep it small: the oldest go past 300 entries
  var keys = Object.keys(cache);
  if (keys.length > 300) {
    keys.sort(function (a, b) { return cache[a].until - cache[b].until; }).slice(0, keys.length - 300).forEach(function (k) { delete cache[k]; });
  }
  return value;
}

function lang(ctx) {
  var l = String(ctx && ctx.locale || 'en').slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(l) ? l : 'en';
}

/** Videos by id (≤ 50), in that order; private / removed ones left out */
function videos(ids, ctx, token) {
  ids = ids.filter(function (id) { return ID.test(id); }).slice(0, 50);
  if (!ids.length) return Promise.resolve([]);
  return yt('videos', { part: 'snippet,contentDetails,statistics,status', id: ids.join(','), hl: lang(ctx), maxResults: 50 }, token).then(function (b) {
    var byId = {};
    (b.items || []).forEach(function (it) { byId[it.id] = video(it); });
    return ids.map(function (id) { return byId[id]; }).filter(Boolean);
  });
}

/** A videos.list item → what a card needs */
function video(it) {
  var s = it.snippet || {}, loc = s.localized || {};
  return {
    id: it.id,
    title: unescape(loc.title || s.title || ''),
    description: loc.description || s.description || '',
    channel: unescape(s.channelTitle || ''),
    channelId: s.channelId || null,
    published: s.publishedAt || null,
    duration: seconds(it.contentDetails && it.contentDetails.duration),
    views: it.statistics ? it.statistics.viewCount : null,
    live: s.liveBroadcastContent === 'live' ? 'live' : s.liveBroadcastContent === 'upcoming' ? 'upcoming' : null,
    image: thumb(s.thumbnails, 'high'),
    backdrop: thumb(s.thumbnails, 'maxres'),
    embeddable: !(it.status && it.status.embeddable === false)
  };
}

// ── cards ───────────────────────────────────────────────────────────────────

function videoCard(v) {
  var when = v.live === 'live' ? 'Live now' : v.live === 'upcoming' ? 'Upcoming' : ago(v.published);
  var views = v.live === 'live' ? '' : count(v.views, 'view');
  var meta = [];
  if (views) meta.push({ kind: 'text', text: views });
  if (when) meta.push({ kind: 'text', text: when });
  if (v.live === 'live') meta.push({ kind: 'chip', text: 'Live' });
  else if (v.duration) meta.push({ kind: 'chip', text: clock(v.duration) });
  if (!v.embeddable) meta.push({ kind: 'chip', text: 'Plays on YouTube only' });
  return {
    key: 'youtube:v:' + v.id,
    title: clip(v.title || 'Untitled', 200),
    variant: 'still',
    image: v.image,
    subtitle: clip([v.channel, views, when].filter(Boolean).join(' · '), 200),
    badges: v.live === 'live' ? [{ text: 'LIVE' }] : v.duration ? [{ text: clock(v.duration) }] : [],
    call: { data: 'play', args: { id: v.id, title: clip(v.title, 200), channel: clip(v.channel, 200), embeddable: v.embeddable } },
    info: {
      title: clip(v.title || 'Untitled', 200),
      eyebrow: clip(v.channel, 200),
      meta: meta,
      overview: clip(v.description, 600),
      overviewFallback: 'No description.',
      backdrop: v.backdrop || v.image
    }
  };
}

function channelCard(c) {
  var subs = c.subscribers != null ? count(c.subscribers, 'subscriber') : '';
  return {
    key: 'youtube:c:' + c.id,
    title: clip(c.title || 'Channel', 200),
    variant: 'portrait',
    image: c.image,
    subtitle: subs || undefined,
    intent: { screen: 'plugin.youtube.channel', params: { id: c.id } },
    info: {
      title: clip(c.title || 'Channel', 200),
      eyebrow: 'Channel',
      meta: subs ? [{ kind: 'text', text: subs }] : [],
      overview: clip(c.description, 600),
      overviewFallback: 'No description.'
    }
  };
}

function playlistCard(p) {
  var items = p.count != null ? count(p.count, 'video') : '';
  return {
    key: 'youtube:p:' + p.id,
    title: clip(p.title || 'Playlist', 200),
    variant: 'still',
    image: p.image,
    subtitle: clip([p.channel, items].filter(Boolean).join(' · '), 200) || undefined,
    badges: [{ text: 'Playlist' }],
    intent: { screen: 'plugin.youtube.playlist', params: { id: p.id } },
    info: {
      title: clip(p.title || 'Playlist', 200),
      eyebrow: p.channel ? clip(p.channel, 200) : 'Playlist',
      meta: items ? [{ kind: 'chip', text: 'Playlist' }, { kind: 'text', text: items }] : [{ kind: 'chip', text: 'Playlist' }],
      overview: clip(p.description, 600),
      overviewFallback: 'A playlist.',
      backdrop: p.image
    }
  };
}

function channelOf(it) {
  var s = it.snippet || {};
  return {
    id: typeof it.id === 'string' ? it.id : (it.id && it.id.channelId) || (s.resourceId && s.resourceId.channelId),
    title: unescape(s.title),
    description: s.description || '',
    image: thumb(s.thumbnails, 'high'),
    subscribers: it.statistics && !it.statistics.hiddenSubscriberCount ? it.statistics.subscriberCount : null
  };
}

function playlistOf(it) {
  var s = it.snippet || {};
  return {
    id: typeof it.id === 'string' ? it.id : it.id && it.id.playlistId,
    title: unescape(s.title),
    description: s.description || '',
    channel: unescape(s.channelTitle || ''),
    image: thumb(s.thumbnails, 'high'),
    count: it.contentDetails ? it.contentDetails.itemCount : null
  };
}

function row(key, title, items, variant) {
  return { key: 'youtube:' + key, title: title, variant: variant || 'still', items: items.slice(0, 100) };
}

function pagedRow(key, title, args, variant) {
  return { key: 'youtube:' + key, title: title, variant: variant || 'still', page: { data: 'page', args: args } };
}

// ── settings, kids, the linked account ──────────────────────────────────────

function settingsOf(ctx) {
  return Promise.all([playpex.settings.get('region', ctx), playpex.settings.get('kids', ctx)]).then(function (v) {
    return { region: /^[A-Z]{2}$/.test(v[0] || '') ? v[0] : 'US', kids: v[1] === 'search' ? 'search' : 'off' };
  });
}

/** The profile's linked Google account's access token, or null */
function tokenOf(ctx) {
  if (!ctx || !ctx.profile) return Promise.resolve(null);
  return playpex.link.status('google', ctx.profile.id).then(function (s) {
    return s && s.linked && s.accessToken ? s.accessToken : null;
  }, function () { return null; });
}

// ── rows ────────────────────────────────────────────────────────────────────

/** The region's chart (a category's, or everything), 50 videos */
function chart(region, category, ctx) {
  return cached('chart:' + region + ':' + (category || '') + ':' + lang(ctx), 30 * 60000, function () {
    return yt('videos', { part: 'snippet,contentDetails,statistics,status', chart: 'mostPopular', regionCode: region,
      videoCategoryId: category || undefined, hl: lang(ctx), maxResults: 50 }).then(function (b) {
      return (b.items || []).map(video);
    }, function (err) {
      // no chart for that category in the region: kept as empty (asked again in 30 min)
      if (err.reason === 'notFound' || err.reason === 'upstream' && /HTTP 400/.test(err.message)) return [];
      throw err;
    });
  });
}

/** Trending, then the categories that have a chart there */
function chartRows(region, ctx) {
  var asks = [['trending', 'Trending', null]].concat(CATEGORIES.map(function (c) { return ['cat' + c[0], c[1], c[0]]; }));
  return Promise.all(asks.map(function (a) {
    return chart(region, a[2], ctx).then(function (list) {
      return list.length ? row(a[0], a[1], list.map(videoCard)) : null;
    }, function (err) {
      if (err.reason === 'nokey' || err.reason === 'quota' || err.reason === 'key') throw err;
      return null;   // no chart for that category there
    });
  })).then(function (rows) { return rows.filter(Boolean); });
}

// a paged playlist's page tokens: page n → its token (in memory: after a reload, a far page starts the list again)
var tokens = {};

/** A page of a playlist (uploads, the user's, any): { items: cards, last } */
function playlistPage(id, page, ctx, token) {
  var key = 'pl:' + id, at = tokens[key] = tokens[key] || { 1: '' };
  if (page > 1 && at[page] === undefined) return Promise.resolve({ items: [], last: true });
  return cached('page:' + id + ':' + page + ':' + (token ? ctx.profile.id : ''), 10 * 60000, function () {
    return yt('playlistItems', { part: 'contentDetails', playlistId: id, maxResults: 50, pageToken: at[page] || undefined }, token).then(function (b) {
      if (b.nextPageToken) at[page + 1] = b.nextPageToken;
      var ids = (b.items || []).map(function (it) { return it.contentDetails && it.contentDetails.videoId; });
      return videos(ids, ctx, token).then(function (list) {
        return { items: list.map(videoCard), last: !b.nextPageToken };
      });
    });
  });
}

/** The newest uploads of the profile's subscriptions (≤ 10 channels' last 10 each), newest first */
function feed(ctx, token) {
  return cached('feed:' + ctx.profile.id, 30 * 60000, function () {
    return yt('subscriptions', { part: 'snippet', mine: 'true', maxResults: 50, order: 'relevance' }, token).then(function (b) {
      var channels = (b.items || []).map(channelOf).filter(function (c) { return CHANNEL.test(c.id || ''); }).slice(0, FEED_CHANNELS);
      // a channel's uploads playlist is its id with UU for UC
      return Promise.all(channels.map(function (c) {
        return yt('playlistItems', { part: 'contentDetails', playlistId: 'UU' + c.id.slice(2), maxResults: 10 }, token).then(function (p) {
          return (p.items || []).map(function (it) { return it.contentDetails || {}; });
        }, function () { return []; });
      }));
    }).then(function (lists) {
      var all = [].concat.apply([], lists).filter(function (x) { return x.videoId; });
      all.sort(function (a, b) { return (Date.parse(b.videoPublishedAt) || 0) - (Date.parse(a.videoPublishedAt) || 0); });
      return videos(all.slice(0, 50).map(function (x) { return x.videoId; }), ctx, token);
    });
  });
}

function subscriptions(ctx, token) {
  return cached('subs:' + ctx.profile.id, 30 * 60000, function () {
    return yt('subscriptions', { part: 'snippet', mine: 'true', maxResults: 50, order: 'alphabetical' }, token).then(function (b) {
      return (b.items || []).map(channelOf).filter(function (c) { return CHANNEL.test(c.id || ''); });
    });
  });
}

function myPlaylists(ctx, token) {
  return cached('lists:' + ctx.profile.id, 30 * 60000, function () {
    return yt('playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: 50 }, token).then(function (b) {
      return (b.items || []).map(playlistOf).filter(function (p) { return LIST.test(p.id || ''); });
    });
  });
}

function liked(ctx, token) {
  return cached('liked:' + ctx.profile.id, 15 * 60000, function () {
    return yt('videos', { part: 'snippet,contentDetails,statistics,status', myRating: 'like', maxResults: 50, hl: lang(ctx) }, token).then(function (b) {
      return (b.items || []).map(video);
    });
  });
}

/** A search: { videos, channels, playlists } */
function search(q, ctx, s) {
  var safe = ctx.profile && ctx.profile.kids ? 'strict' : 'moderate';
  return cached('search:' + safe + ':' + s.region + ':' + q.toLowerCase(), 60 * 60000, function () {
    return yt('search', { part: 'snippet', q: q, type: 'video,channel,playlist', maxResults: 50, safeSearch: safe,
      regionCode: s.region, relevanceLanguage: lang(ctx) }).then(function (b) {
      var items = b.items || [];
      var videoIds = items.filter(function (it) { return it.id && it.id.kind === 'youtube#video'; }).map(function (it) { return it.id.videoId; });
      var channels = items.filter(function (it) { return it.id && it.id.kind === 'youtube#channel'; }).map(channelOf);
      var playlists = items.filter(function (it) { return it.id && it.id.kind === 'youtube#playlist'; }).map(playlistOf);
      var channelIds = channels.map(function (c) { return c.id; }).filter(function (id) { return CHANNEL.test(id || ''); });
      return Promise.all([
        videos(videoIds, ctx),
        // subscriber counts: one call for every channel found
        channelIds.length ? yt('channels', { part: 'snippet,statistics', id: channelIds.join(','), maxResults: 50 }).then(function (c) {
          var byId = {};
          (c.items || []).forEach(function (it) { byId[it.id] = channelOf(it); });
          return channelIds.map(function (id) { return byId[id]; }).filter(Boolean);
        }, function () { return channels; }) : []
      ]).then(function (r) {
        return { videos: r[0], channels: r[1], playlists: playlists.filter(function (p) { return LIST.test(p.id || ''); }) };
      });
    });
  });
}

function searchRows(found, q) {
  var rows = [];
  if (found.videos.length) rows.push(row('search-videos', 'Videos for “' + clip(q, 60) + '”', found.videos.map(videoCard)));
  if (found.channels.length) rows.push(row('search-channels', 'Channels', found.channels.map(channelCard), 'portrait'));
  if (found.playlists.length) rows.push(row('search-playlists', 'Playlists', found.playlists.map(playlistCard)));
  return rows;
}

// ── screens ─────────────────────────────────────────────────────────────────

function screen(title, rows, extra) {
  var data = { title: title, rows: rows, search: true };
  Object.keys(extra || {}).forEach(function (k) { data[k] = extra[k]; });
  return { data: data };
}

playpex.data('home', function (args, ctx) {
  var q = String(args && args.query || '').trim().slice(0, 100);
  var kid = !!(ctx.profile && ctx.profile.kids);
  return Promise.all([settingsOf(ctx), tokenOf(ctx)]).then(function (r) {
    var s = r[0], token = r[1];
    if (kid && s.kids === 'off') {
      return { data: { title: 'YouTube', rows: [], empty: 'YouTube is off for kids profiles. The server\'s admin can change that on the dashboard.' } };
    }
    if (q) {
      return search(q, ctx, s).then(function (found) {
        return screen('YouTube', searchRows(found, q), { empty: 'Nothing on YouTube for “' + clip(q, 60) + '”.' });
      }, function (err) {
        return screen('YouTube', [], { empty: explain(err) });
      });
    }
    // a linked account's rows: each its own paged row (they load side by side, after the screen shows)
    var mine = token ? [
      pagedRow('feed', 'From your subscriptions', { list: 'feed' }),
      pagedRow('subscriptions', 'Your subscriptions', { list: 'subscriptions' }, 'portrait'),
      pagedRow('liked', 'Liked videos', { list: 'liked' }),
      pagedRow('playlists', 'Your playlists', { list: 'playlists' })
    ] : [];
    if (kid) {
      return screen('YouTube', mine, { empty: 'Search YouTube (SafeSearch is on).' });
    }
    return chartRows(s.region, ctx).then(function (rows) {
      return screen('YouTube', mine.concat(rows), { empty: 'YouTube has nothing to show here right now.' });
    }, function (err) {
      return screen('YouTube', mine, { empty: explain(err) });
    });
  });
});

playpex.data('channel', function (args, ctx) {
  var id = String(args && args.params && args.params.id || '');
  if (!CHANNEL.test(id)) return Promise.resolve({ data: { title: 'YouTube', rows: [], empty: 'No such channel.' } });
  var q = String(args.query || '').trim().slice(0, 100);
  return settingsOf(ctx).then(function (s) {
    if (ctx.profile && ctx.profile.kids && s.kids === 'off') {
      return { data: { title: 'YouTube', rows: [], empty: 'YouTube is off for kids profiles.' } };
    }
    if (q) {
      return search(q, ctx, s).then(function (found) {
        return screen('YouTube', searchRows(found, q), { empty: 'Nothing on YouTube for “' + clip(q, 60) + '”.' });
      }, function (err) { return screen('YouTube', [], { empty: explain(err) }); });
    }
    return cached('channel:' + id, 30 * 60000, function () {
      return Promise.all([
        yt('channels', { part: 'snippet,statistics', id: id }),
        yt('playlists', { part: 'snippet,contentDetails', channelId: id, maxResults: 50 }).then(function (b) { return b.items || []; }, function () { return []; })
      ]);
    }).then(function (r) {
      var it = (r[0].items || [])[0];
      if (!it) return { data: { title: 'YouTube', rows: [], empty: 'No such channel.' } };
      var c = channelOf(it), lists = r[1].map(playlistOf).filter(function (p) { return LIST.test(p.id || ''); });
      var rows = [pagedRow('uploads', 'Latest from ' + clip(c.title, 80), { list: 'playlist', id: 'UU' + id.slice(2) })];
      if (lists.length) rows.push(row('channel-playlists', 'Playlists', lists.map(playlistCard)));
      return screen(clip(c.title || 'Channel', 200), rows, { empty: 'This channel has no videos.' });
    }, function (err) {
      return screen('YouTube', [], { empty: explain(err) });
    });
  });
});

playpex.data('playlist', function (args, ctx) {
  var id = String(args && args.params && args.params.id || '');
  if (!LIST.test(id)) return Promise.resolve({ data: { title: 'YouTube', rows: [], empty: 'No such playlist.' } });
  return Promise.all([settingsOf(ctx), tokenOf(ctx)]).then(function (r) {
    var s = r[0], token = r[1];
    if (ctx.profile && ctx.profile.kids && s.kids === 'off') {
      return { data: { title: 'YouTube', rows: [], empty: 'YouTube is off for kids profiles.' } };
    }
    // a private playlist of the linked account reads with its token
    return cached('playlist:' + id + ':' + (token ? ctx.profile.id : ''), 30 * 60000, function () {
      return yt('playlists', { part: 'snippet,contentDetails', id: id }, token);
    }).then(function (b) {
      var it = (b.items || [])[0];
      if (!it) return { data: { title: 'YouTube', rows: [], empty: 'This playlist is private or gone.' } };
      var p = playlistOf(it);
      return { data: { title: clip(p.title || 'Playlist', 200), rows: [pagedRow('playlist', p.channel ? 'By ' + clip(p.channel, 80) : 'Videos', { list: 'playlist', id: id })],
        empty: 'This playlist is empty.' } };
    }, function (err) {
      return { data: { title: 'YouTube', rows: [], empty: explain(err) } };
    });
  });
});

// paged rows: { list: feed | subscriptions | liked | playlists | playlist (+ id), page }
playpex.data('page', function (args, ctx) {
  var list = String(args && args.list || ''), page = Math.max(1, Math.floor(Number(args && args.page) || 1));
  var none = { data: { items: [], last: true } };
  return Promise.all([settingsOf(ctx), tokenOf(ctx)]).then(function (r) {
    var s = r[0], token = r[1];
    if (ctx.profile && ctx.profile.kids && s.kids === 'off') return none;
    if (list === 'playlist') {
      var id = String(args.id || '');
      if (!LIST.test(id)) return none;
      return playlistPage(id, page, ctx, token).then(function (p) { return { data: p }; });
    }
    // the linked account's rows: one page each
    if (!token || page > 1) return none;
    var made = list === 'feed' ? feed(ctx, token).then(function (v) { return v.map(videoCard); })
      : list === 'subscriptions' ? subscriptions(ctx, token).then(function (c) { return c.map(channelCard); })
      : list === 'liked' ? liked(ctx, token).then(function (v) { return v.map(videoCard); })
      : list === 'playlists' ? myPlaylists(ctx, token).then(function (p) { return p.map(playlistCard); })
      : Promise.resolve([]);
    return made.then(function (items) { return { data: { items: items.slice(0, 100), last: true } }; });
  }).catch(function (err) {
    playpex.log.warn('a row failed: ' + (err.reason || '') + ' ' + err.message, { list: list });
    return none;
  });
});

// a video card's call: YouTube's player, under the client's controls
playpex.data('play', function (args, ctx) {
  var id = String(args && args.id || '');
  if (!ID.test(id)) return Promise.resolve({ data: null, effects: [{ type: 'toast', text: 'That video can\'t be played.', tone: 'error' }] });
  if (args.embeddable === false) {
    return Promise.resolve({ data: null, effects: [{ type: 'toast', text: 'Its owner only lets this video play on YouTube itself.', tone: 'error' }] });
  }
  var title = clip(args.title || 'YouTube', 200);
  var request = { title: title, sources: [{ kind: 'embed', provider: 'youtube', id: id, label: title }], tracking: 'none' };
  if (args.channel) request.subtitle = clip(args.channel, 200);
  return Promise.resolve({ data: null, effects: [{ type: 'play', request: request }] });
});

// The search page's chip: YouTube's videos and channels for the query
playpex.data('searchFilter', function (args, ctx) {
  var q = String(args && args.context && args.context.query || '').trim().slice(0, 100);
  var chip = { key: 'youtube:search', label: 'YouTube' };
  if (q.length < 2) return Promise.resolve({ data: { chip: chip, rows: [] } });
  return settingsOf(ctx).then(function (s) {
    if (ctx.profile && ctx.profile.kids && s.kids === 'off') return { data: { chip: chip, rows: [] } };
    return search(q, ctx, s).then(function (found) {
      return { data: { chip: chip, rows: searchRows(found, q) } };
    });
  }).catch(function () {
    return { data: { chip: chip, rows: [] } };
  });
});

// tests (Node, not the sandbox): the pure parts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { seconds: seconds, clock: clock, count: count, ago: ago, unescape: unescape, thumb: thumb, video: video,
    videoCard: videoCard, channelCard: channelCard, playlistCard: playlistCard, explain: explain };
}
