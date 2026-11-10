// YouTube for Playpex (plugins/youtube): browsing with the YouTube Data API v3
// (the admin's API key, its secret `apiKey`), a linked Google account per
// profile for its subscriptions, liked videos and playlists (device code,
// read-only scope; the host keeps and refreshes the tokens), and videos played
// as `embed` sources: YouTube's own IFrame player in the client, under the
// client's controls (SERVER_PLUGIN_API 1.3).
//
// Screens (catalog template):
//   home       a View filter: For you (Playpex's own recommendations: YouTube's
//              home feed isn't in its public API), Subscriptions, Liked videos,
//              Your playlists, Trending; a Category filter narrowing them; a
//              search → videos, channels, playlists
//   channel    a channel's uploads (paged) and playlists         params { id }
//   playlist   a playlist's videos (paged)                       params { id }
// Data handlers: home, channel, playlist, page (paged rows), play (a card's
// call → a play effect), searchFilter (the search page's chip).
//
// Quota (10,000 units a day per key): a list call costs 1, a search 100. Rows
// are cached in memory (30 min, a search 1 h); the subscriptions feed reads at
// most 10 channels' uploads (1 unit each); For you is made at most every 3 h
// per profile (≈ 15 units, plus one search of 100 cached 12 h).
//
// For you: what a profile played here (its history, in the store, kept by the
// play handler: ≤ 200 videos), its liked videos and subscriptions (a linked
// account) → the channels and categories it watches most (recent plays weigh
// more) → their latest uploads, the region's charts of those categories, and
// a search on the last video it played; already watched or liked videos left
// out. With nothing to go on yet: the region's charts.

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
  return yt('videos', { part: VIDEO_PARTS, maxHeight: PLAYER_HEIGHT, id: ids.join(','), hl: lang(ctx), maxResults: 50 }, token).then(function (b) {
    var byId = {};
    videosOf(b.items).forEach(function (v) { byId[v.id] = v; });
    return ids.map(function (id) { return byId[id]; }).filter(Boolean);
  });
}

// Shorts: shown where people browse (marked "Short"), never recommended (For
// you leaves them out). YouTube's API has no flag for them, so a video is one
// when its player is taller than wide (part player, sized by maxHeight) and it
// lasts at most 3 minutes, or it lasts a minute at most, or says #shorts. For
// you reads channels' uploads from their long-videos lists (UULF…: no Shorts,
// no live streams), the whole uploads (UU…) when a channel has none
var VIDEO_PARTS = 'snippet,contentDetails,statistics,status,player';
var PLAYER_HEIGHT = 360;

function isShort(it, duration) {
  var p = it.player || {}, w = Number(p.embedWidth), h = Number(p.embedHeight);
  var s = it.snippet || {};
  if (s.liveBroadcastContent === 'live' || s.liveBroadcastContent === 'upcoming') return false;
  if (duration > 0 && duration <= 60) return true;
  if (duration > 0 && duration <= 180 && w > 0 && h > w) return true;
  return duration > 0 && duration <= 180 && /#shorts?\b/i.test((s.title || '') + ' ' + (s.description || '').slice(0, 300));
}

/** videos.list items → videos (Shorts included, marked `short`) */
function videosOf(items) {
  return (items || []).map(video);
}

/** Without Shorts: what For you recommends */
function noShorts(list) {
  return list.filter(function (v) { return !v.short; });
}

/** A channel's uploads, all of them */
function uploadsOf(channelId) {
  return 'UU' + channelId.slice(2);
}

/** A channel's long videos (its uploads without Shorts and live streams): For you's */
function longUploadsOf(channelId) {
  return 'UULF' + channelId.slice(2);
}

/** playlistItems.list; a channel's long-videos list it doesn't have → its whole uploads */
function playlistItems(params, token) {
  return yt('playlistItems', params, token).catch(function (err) {
    if (err.reason === 'notFound' && /^UULF/.test(params.playlistId || '')) {
      return yt('playlistItems', Object.assign({}, params, { playlistId: 'UU' + params.playlistId.slice(4) }), token);
    }
    throw err;
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
    categoryId: /^\d{1,3}$/.test(s.categoryId || '') ? s.categoryId : null,
    published: s.publishedAt || null,
    duration: seconds(it.contentDetails && it.contentDetails.duration),
    short: isShort(it, seconds(it.contentDetails && it.contentDetails.duration)),
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
  else if (v.short) meta.push({ kind: 'chip', text: 'Short · ' + clock(v.duration) });
  else if (v.duration) meta.push({ kind: 'chip', text: clock(v.duration) });
  if (!v.embeddable) meta.push({ kind: 'chip', text: 'Plays on YouTube only' });
  return {
    key: 'youtube:v:' + v.id,
    title: clip(v.title || 'Untitled', 200),
    variant: 'still',
    image: v.image,
    subtitle: clip([v.channel, views, when].filter(Boolean).join(' · '), 200),
    badges: v.live === 'live' ? [{ text: 'LIVE' }] : v.short ? [{ text: 'Short' }] : v.duration ? [{ text: clock(v.duration) }] : [],
    call: { data: 'play', args: { id: v.id, title: clip(v.title, 200), channel: clip(v.channel, 200), embeddable: v.embeddable,
      channelId: v.channelId, categoryId: v.categoryId } },
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
    return yt('videos', { part: VIDEO_PARTS, maxHeight: PLAYER_HEIGHT, chart: 'mostPopular', regionCode: region,
      videoCategoryId: category || undefined, hl: lang(ctx), maxResults: 50 }).then(function (b) {
      return videosOf(b.items);
    }, function (err) {
      // no chart for that category in the region: kept as empty (asked again in 30 min)
      if (err.reason === 'notFound' || err.reason === 'upstream' && /HTTP 400/.test(err.message)) return [];
      throw err;
    });
  });
}

/** Trending, then the categories that have a chart there; `options.noShorts`: For you's */
function chartRows(region, ctx, options) {
  var keep = options && options.noShorts ? noShorts : function (list) { return list; };
  var asks = [['trending', 'Trending', null]].concat(CATEGORIES.map(function (c) { return ['cat' + c[0], c[1], c[0]]; }));
  return Promise.all(asks.map(function (a) {
    return chart(region, a[2], ctx).then(function (list) {
      list = keep(list);
      return list.length ? row(a[0], a[1], list.map(videoCard)) : null;
    }, function (err) {
      if (err.reason === 'nokey' || err.reason === 'quota' || err.reason === 'key') throw err;
      return null;   // no chart for that category there
    });
  })).then(function (rows) { return rows.filter(Boolean); });
}

// paged lists' page tokens: page n → its token (in memory: after a reload, a far page starts the list again)
var tokens = {};

/** A page of a list YouTube pages with tokens: `ask(pageToken)` → { body, ids? | videos? } */
function tokenPage(key, page, ask) {
  var at = tokens[key] = tokens[key] || { 1: '' };
  if (page > 1 && at[page] === undefined) return Promise.resolve({ items: [], last: true });
  return ask(at[page] || undefined).then(function (r) {
    if (r.next) at[page + 1] = r.next;
    return { items: r.videos.map(videoCard), last: !r.next };
  });
}

/** Liked videos, a page (a linked account): optionally of one category */
function likedPage(page, ctx, token, category) {
  return tokenPage('liked:' + ctx.profile.id, page, function (pageToken) {
    return cached('likedp:' + ctx.profile.id + ':' + page, 15 * 60000, function () {
      return yt('videos', { part: VIDEO_PARTS, maxHeight: PLAYER_HEIGHT, myRating: 'like', maxResults: 50, pageToken: pageToken, hl: lang(ctx) }, token);
    }).then(function (b) {
      var list = videosOf(b.items).filter(function (v) { return !category || v.categoryId === category; });
      return { videos: list, next: b.nextPageToken };
    });
  });
}

/** A category's chart in the region, a page (≤ 200 videos in all) */
function chartPage(region, category, page, ctx, withoutShorts) {
  return tokenPage('chart:' + region + ':' + category, page, function (pageToken) {
    return cached('chartp:' + region + ':' + category + ':' + page + ':' + lang(ctx), 30 * 60000, function () {
      return yt('videos', { part: VIDEO_PARTS, maxHeight: PLAYER_HEIGHT, chart: 'mostPopular', regionCode: region,
        videoCategoryId: category || undefined, maxResults: 50, pageToken: pageToken, hl: lang(ctx) });
    }).then(function (b) {
      var list = videosOf(b.items);
      return { videos: withoutShorts ? noShorts(list) : list, next: b.nextPageToken };
    }, function (err) {
      if (err.reason === 'notFound') return { videos: [], next: null };
      throw err;
    });
  });
}

/** A page of a playlist (uploads, the user's, any): { items: cards, last } */
function playlistPage(id, page, ctx, token) {
  var key = 'pl:' + id, at = tokens[key] = tokens[key] || { 1: '' };
  if (page > 1 && at[page] === undefined) return Promise.resolve({ items: [], last: true });
  return cached('page:' + id + ':' + page + ':' + (token ? ctx.profile.id : ''), 10 * 60000, function () {
    return playlistItems({ part: 'contentDetails', playlistId: id, maxResults: 50, pageToken: at[page] || undefined }, token).then(function (b) {
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
        return playlistItems({ part: 'contentDetails', playlistId: uploadsOf(c.id), maxResults: 10 }, token).then(function (p) {
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
    return yt('videos', { part: VIDEO_PARTS, maxHeight: PLAYER_HEIGHT, myRating: 'like', maxResults: 50, hl: lang(ctx) }, token).then(function (b) {
      return videosOf(b.items);
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

// ── the profile's history ───────────────────────────────────────────────────

var HISTORY_MAX = 200;

function historyKey(ctx) {
  return 'history:' + ctx.profile.id;
}

/** What the profile played here, newest first: [{ id, title, channelId, categoryId, at }] */
function history(ctx) {
  if (!ctx || !ctx.profile) return Promise.resolve([]);
  return playpex.store.get(historyKey(ctx)).then(function (list) { return Array.isArray(list) ? list : []; }, function () { return []; });
}

function remember(ctx, entry) {
  if (!ctx || !ctx.profile) return Promise.resolve();
  return history(ctx).then(function (list) {
    list = [entry].concat(list.filter(function (h) { return h.id !== entry.id; })).slice(0, HISTORY_MAX);
    // For you takes it into account soon (not at once: every play would make it again)
    var made = cache['foryou:' + ctx.profile.id];
    if (made) made.until = Math.min(made.until, Date.now() + 20 * 60000);
    return playpex.store.set(historyKey(ctx), list);
  }).catch(function (err) {
    playpex.log.warn('the history wasn\'t kept: ' + err.message);
  });
}

// ── For you ─────────────────────────────────────────────────────────────────

/** A recent title's words to search for: no brackets, separators, hashtags or "official video" */
function searchWords(title) {
  var words = String(title || '').replace(/[\[(【][^\])】]*[\])】]/g, ' ').split(/\s[|•·\-–—:]\s|\s?[|•·]\s?/)[0]
    .replace(/#\S+/g, ' ').replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/)
    .filter(function (w) { return w && !/^(official|video|music|lyrics?|audio|hd|4k|full|ft|feat)$/i.test(w); });
  return words.slice(0, 6).join(' ');
}

/** Weights of the channels and categories a profile watches: { channels: [[id, w]], categories: [[id, w]] } */
function affinities(hist, likedVideos) {
  var ch = {}, cat = {}, now = Date.now();
  function add(map, key, w) {
    if (key) map[key] = (map[key] || 0) + w;
  }
  hist.forEach(function (h) {
    var days = Math.max(0, (now - (Date.parse(h.at) || now)) / 86400000);
    var w = 3 * Math.pow(0.5, days / 14);     // a play counts half after two weeks
    add(ch, h.channelId, w);
    add(cat, h.categoryId, w);
  });
  likedVideos.forEach(function (v) {
    add(ch, v.channelId, 2);
    add(cat, v.categoryId, 2);
  });
  function sorted(map) {
    return Object.keys(map).map(function (k) { return [k, map[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
  }
  return { channels: sorted(ch), categories: sorted(cat) };
}

/** Takes from each list in turn (the first first), each video once, without the ones in `skip` */
function interleave(lists, skip, max) {
  var out = [], seen = {}, i = 0, more = true;
  Object.keys(skip).forEach(function (k) { seen[k] = true; });
  while (out.length < max && more) {
    more = false;
    lists.forEach(function (list) {
      var v = list[i];
      if (v) more = true;
      if (v && !seen[v.id] && out.length < max) {
        seen[v.id] = true;
        out.push(v);
      }
    });
    i++;
  }
  return out;
}

function categoryName(id) {
  var c = CATEGORIES.filter(function (x) { return x[0] === id; })[0];
  return c ? c[1] : null;
}

/** The profile's For you: [{ key, title, videos }], made at most every 3 h */
function forYou(ctx, token, s) {
  return cached('foryou:' + ctx.profile.id + ':' + s.region, 3 * 3600000, function () {
    return Promise.all([
      history(ctx),
      token ? liked(ctx, token).catch(function () { return []; }) : [],
      token ? feed(ctx, token).catch(function () { return []; }) : []
    ]).then(function (r) {
      var hist = r[0], likedVideos = r[1], subs = r[2];
      var aff = affinities(hist, likedVideos);
      var skip = {};
      hist.forEach(function (h) { skip[h.id] = true; });
      likedVideos.forEach(function (v) { skip[v.id] = true; });
      var channels = aff.channels.slice(0, 6).map(function (c) { return c[0]; }).filter(function (id) { return CHANNEL.test(id); });
      var categories = aff.categories.slice(0, 3).map(function (c) { return c[0]; }).filter(function (id) { return categoryName(id); });
      var last = hist[0] || likedVideos[0] || null;
      var words = last ? searchWords(last.title) : '';
      return Promise.all([
        // the channels it watches: their latest uploads
        Promise.all(channels.map(function (id) {
          return cached('uploads:' + id, 60 * 60000, function () {
            return playlistItems({ part: 'contentDetails', playlistId: longUploadsOf(id), maxResults: 12 }).then(function (b) {
              return (b.items || []).map(function (it) { return it.contentDetails && it.contentDetails.videoId; }).filter(Boolean);
            });
          }).catch(function () { return []; });
        })),
        // its categories' charts
        Promise.all(categories.map(function (id) { return chart(s.region, id, ctx).catch(function () { return []; }); })),
        // like the last thing it played (one search, cached 12 h)
        words.length >= 3 ? cached('like:' + words.toLowerCase(), 12 * 3600000, function () {
          return yt('search', { part: 'snippet', q: words, type: 'video', maxResults: 25, safeSearch: 'moderate', regionCode: s.region,
            relevanceLanguage: lang(ctx) }).then(function (b) {
            return (b.items || []).map(function (it) { return it.id && it.id.videoId; }).filter(Boolean);
          });
        }).catch(function () { return []; }) : []
      ]).then(function (got) {
        var uploadIds = got[0], charts = got[1], likeIds = got[2];
        var all = [].concat.apply([], uploadIds).concat(likeIds).filter(function (id) { return !skip[id]; });
        var unique = all.filter(function (id, i) { return all.indexOf(id) === i; });
        var batches = [];
        for (var i = 0; i < unique.length && batches.length < 3; i += 50) batches.push(unique.slice(i, i + 50));
        return Promise.all(batches.map(function (b) { return videos(b, ctx); })).then(function (lists) {
          var byId = {};
          [].concat.apply([], lists).forEach(function (v) { byId[v.id] = v; });
          // never a Short
          function pick(ids) { return noShorts(ids.map(function (id) { return byId[id]; }).filter(Boolean)); }
          var fromChannels = uploadIds.map(pick);
          var like = pick(likeIds);
          charts = charts.map(noShorts);
          subs = noShorts(subs);
          var fresh = subs.filter(function (v) { return Date.now() - (Date.parse(v.published) || 0) < 14 * 86400000; });
          var rows = [];
          var top = interleave([fresh, like].concat(fromChannels).concat(charts), skip, 40);
          if (top.length) rows.push({ key: 'foryou', title: 'For you', videos: top });
          if (last && like.length) rows.push({ key: 'because', title: 'Because you watched “' + clip(last.title, 60) + '”', videos: like });
          channels.slice(0, 3).forEach(function (id, i) {
            var list = fromChannels[i] || [];
            if (list.length >= 2) rows.push({ key: 'more-' + id, title: 'More from ' + clip(list[0].channel, 60), videos: list });
          });
          if (subs.length) rows.push({ key: 'new-subs', title: 'New from your subscriptions', videos: subs });
          categories.forEach(function (id, i) {
            var list = (charts[i] || []).filter(function (v) { return !skip[v.id]; });
            if (list.length) rows.push({ key: 'popular-' + id, title: 'Popular in ' + categoryName(id), videos: list });
          });
          return rows;
        });
      });
    });
  });
}

// ── views and categories ────────────────────────────────────────────────────

var VIEWS = [['foryou', 'For you'], ['subscriptions', 'Subscriptions'], ['liked', 'Liked videos'], ['playlists', 'Your playlists'], ['trending', 'Trending']];

function viewOf(args) {
  var v = args.filters && args.filters.view && args.filters.view[0];
  return VIEWS.some(function (x) { return x[0] === v; }) ? v : 'foryou';
}

function categoryOf(args) {
  var c = args.filters && args.filters.category && args.filters.category[0];
  return categoryName(c) ? c : '';
}

function filtersFor(view, category) {
  return [
    // each its own toolbar button opening its own panel (plugin API 1.4)
    { key: 'view', label: 'View', button: true, options: VIEWS.map(function (v) { return { value: v[0], label: v[1], on: v[0] === view }; }) },
    { key: 'category', label: 'Category', button: true, options: [{ value: 'all', label: 'All categories', on: !category }].concat(CATEGORIES.map(function (c) {
      return { value: c[0], label: c[1], on: c[0] === category };
    })) }
  ];
}

/** A row of videos, narrowed to a category when one is chosen (null when nothing is left) */
function videoRow(key, title, list, category) {
  list = category ? list.filter(function (v) { return v.categoryId === category; }) : list;
  return list.length ? row(key, title, list.map(videoCard)) : null;
}

var NOT_LINKED = 'Link a Google account to this profile to see this: the server\'s admin does it on the dashboard (Plugins › YouTube › Accounts).';

/** The rows of a view: Promise<{ rows, empty }> */
function viewRows(view, category, ctx, token, s) {
  var catName = categoryName(category);
  if (view === 'trending') {
    if (category) {
      return Promise.resolve({ rows: [pagedRow('chart-' + category, 'Trending in ' + catName, { list: 'chart', category: category })],
        empty: 'Nothing trending in ' + catName + ' here.' });
    }
    return chartRows(s.region, ctx).then(function (rows) { return { rows: rows, empty: 'YouTube has nothing trending here right now.' }; });
  }
  if (view !== 'foryou' && !token) return Promise.resolve({ rows: [], empty: NOT_LINKED });
  if (view === 'subscriptions') {
    return Promise.all([feed(ctx, token), subscriptions(ctx, token)]).then(function (r) {
      var rows = [videoRow('subs-latest', 'Latest', r[0], category)];
      if (!category) {
        rows.push(r[1].length ? row('subs-channels', 'Your channels', r[1].map(channelCard), 'portrait') : null);
        r[1].slice(0, 12).forEach(function (c) {
          rows.push(pagedRow('subs-' + c.id, clip(c.title || 'Channel', 100), { list: 'playlist', id: uploadsOf(c.id) }));
        });
      }
      return { rows: rows.filter(Boolean), empty: category ? 'No new ' + catName + ' videos from your subscriptions.' : 'You aren\'t subscribed to any channel yet.' };
    });
  }
  if (view === 'liked') {
    var rows = [pagedRow('liked-all', category ? 'Liked: ' + catName : 'All liked videos', category ? { list: 'liked', category: category } : { list: 'liked' })];
    if (category) return Promise.resolve({ rows: rows, empty: 'No liked ' + catName + ' videos.' });
    // the first 50 by category, the categories with a few
    return liked(ctx, token).then(function (list) {
      CATEGORIES.forEach(function (c) {
        var mine = list.filter(function (v) { return v.categoryId === c[0]; });
        if (mine.length >= 3) rows.push(row('liked-' + c[0], c[1], mine.map(videoCard)));
      });
      return { rows: rows, empty: 'You haven\'t liked any video yet.' };
    });
  }
  if (view === 'playlists') {
    return myPlaylists(ctx, token).then(function (lists) {
      var rows = lists.length ? [row('playlists', 'Your playlists', lists.map(playlistCard))] : [];
      lists.slice(0, 10).forEach(function (p) {
        rows.push(pagedRow('playlist-' + p.id, clip(p.title || 'Playlist', 100), { list: 'playlist', id: p.id }));
      });
      return { rows: rows, empty: 'You have no playlists.' };
    });
  }
  // for you (a profile's: without one, the charts)
  return (ctx.profile ? forYou(ctx, token, s) : Promise.resolve([])).then(function (made) {
    var rows = made.map(function (r) { return videoRow(r.key, r.title, r.videos, category); }).filter(Boolean);
    if (rows.length) return { rows: rows, empty: '' };
    // nothing to go on yet (or nothing in that category): the charts, saying how it learns
    return (category ? Promise.resolve([pagedRow('chart-' + category, 'Trending in ' + catName, { list: 'chart', category: category, noShorts: true })])
      : chartRows(s.region, ctx, { noShorts: true })).then(function (charts) {
      if (charts[0]) charts[0] = Object.assign({}, charts[0], { title: charts[0].title + ' · For you learns from what you watch' + (token ? ' and like' : '') });
      return { rows: charts, empty: 'Watch a few videos: For you is made from what you play.' };
    });
  });
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
    // kids (search only): their linked account's rows, no charts or recommendations
    if (kid) {
      var mine = token ? [
        pagedRow('feed', 'From your subscriptions', { list: 'feed' }),
        pagedRow('liked', 'Liked videos', { list: 'liked' }),
        pagedRow('playlists', 'Your playlists', { list: 'playlists' })
      ] : [];
      return screen('YouTube', mine, { empty: 'Search YouTube (SafeSearch is on).' });
    }
    var view = viewOf(args), category = categoryOf(args);
    var title = view === 'foryou' ? 'YouTube' : 'YouTube · ' + VIEWS.filter(function (v) { return v[0] === view; })[0][1];
    return viewRows(view, category, ctx, token, s).then(function (v) {
      return screen(title, v.rows, { filters: filtersFor(view, category), empty: v.empty });
    }, function (err) {
      return screen(title, [], { filters: filtersFor(view, category), empty: explain(err) });
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
      var rows = [pagedRow('uploads', 'Latest from ' + clip(c.title, 80), { list: 'playlist', id: uploadsOf(id) })];
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
    var category = categoryName(args.category) ? String(args.category) : '';
    if (list === 'chart') {
      if (ctx.profile && ctx.profile.kids) return none;
      return chartPage(s.region, category, page, ctx, !!args.noShorts).then(function (p) { return { data: p }; });
    }
    if (list === 'liked' && token) {
      return likedPage(page, ctx, token, category).then(function (p) { return { data: p }; });
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
  // what the profile plays here: For you is made from it
  return remember(ctx, {
    id: id, title: title,
    channelId: CHANNEL.test(args.channelId || '') ? args.channelId : null,
    categoryId: /^\d{1,3}$/.test(args.categoryId || '') ? args.categoryId : null,
    at: new Date().toISOString()
  }).then(function () {
    return { data: null, effects: [{ type: 'play', request: request }] };
  });
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
  module.exports = { isShort: isShort, uploadsOf: uploadsOf, longUploadsOf: longUploadsOf, seconds: seconds, clock: clock, count: count, ago: ago, unescape: unescape, thumb: thumb, video: video,
    searchWords: searchWords, affinities: affinities, interleave: interleave,
    videoCard: videoCard, channelCard: channelCard, playlistCard: playlistCard, explain: explain };
}
