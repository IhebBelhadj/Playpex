// Trakt: scrobbles what a profile watches, keeps its watch list, history and
// ratings in step with a Trakt account, adds Trakt's rating to title pages and
// Trakt's rows to the Movies and TV shows sections (docs/plugins-plan.md §7.3,
// step P6; docs/providers-plan.md §7.3: a metadata provider). Runs in the
// server's sandbox (docs/plugins/server.md); everything is set up on the
// dashboard: the Trakt app's client id and secret (Settings, advanced), a
// profile's account (Accounts), what it may do for a profile (Profiles).
//
//   hook metadata.details   Trakt's rating of a movie / show and a link to it (the app's client id only)
//   events playback.*       scrobble start / pause / stop, for linked profiles granted events.playback
//                           whose setting "Scrobble what I watch" is on
//   events watchlist.*, watched.*, rating.set   the profile's own changes, sent to Trakt (never our writes:
//                           the core doesn't send them back)
//   job sync (every 15 min) profiles whose interval is up, linked, sync not off, granted the write scope:
//                           the watch list both ways (removals too), Trakt's history since the last sync
//                           and its ratings into Playpex; a notification of what it added
//   data movieRows / showRows   "Trending on Trakt", "Recommended for you on Trakt" (linked)
//   data syncNow            the dashboard's Sync now: every profile at once
//
// Titles: TMDB ids both ways (Trakt has them). An episode's tmdbId is its show's.

var API = 'https://api.trakt.tv';
var LINK = 'trakt';
var INTERVALS = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000, '6h': 6 * 60 * 60 * 1000 };
var FIRST_HISTORY_DAYS = 30;     // the first sync reads this much of Trakt's history
var MAX_PAGES = 5;               // of 100: what one sync reads of a history
var SENT_DAYS = 7;               // what we sent to Trakt isn't brought back for this long
var CACHE_MS = 60 * 60 * 1000;

// ── Trakt's API ─────────────────────────────────────────────────────────────

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

/** A Trakt request: { body, pages } (null for a 409: just scrobbled / already there) */
async function trakt(path, options) {
  options = options || {};
  var id = await playpex.secrets.get('traktClientId');
  if (!id) {
    throw failure('NOT_CONFIGURED', 'no Trakt client id yet (the dashboard: Plugins › Trakt › Settings)');
  }
  var headers = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': id };
  if (options.token) {
    headers.Authorization = 'Bearer ' + options.token;
  }
  var res = await playpex.http.request({
    url: API + path, method: options.method || 'GET', headers: headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body), responseType: 'json'
  });
  if (res.status === 409) {
    return null;
  }
  if (res.status < 200 || res.status >= 300) {
    throw failure('HTTP_' + res.status, path.split('?')[0] + ' answered HTTP ' + res.status);
  }
  return { body: res.body, pages: Number((res.headers || {})['x-pagination-page-count']) || 1 };
}

var cache = {};

/** A public GET (client id only), cached an hour */
function cached(path) {
  var hit = cache[path];
  if (hit && hit.expires > Date.now()) {
    return hit.value;
  }
  var value = trakt(path).then(function (r) { return r ? r.body : null; });
  cache[path] = { value: value, expires: Date.now() + CACHE_MS };
  value.catch(function () { delete cache[path]; });
  return value;
}

/** A profile's access token, or null when its account isn't linked */
async function token(profileId) {
  var s = await playpex.link.status(LINK, profileId);
  return s && s.linked ? s.accessToken : null;
}

// ── titles ──────────────────────────────────────────────────────────────────

function key(ref) {
  return ref.kind === 'episode' ? 'episode:' + ref.tmdbId + ':' + ref.season + ':' + ref.episode : ref.kind + ':' + ref.tmdbId;
}

/** A Trakt list body ({ movies } or { shows }) holding one title, `extra` on its innermost item */
function body(ref, extra) {
  extra = extra || {};
  if (ref.kind === 'movie') {
    return { movies: [Object.assign({ ids: { tmdb: ref.tmdbId } }, extra)] };
  }
  if (ref.kind === 'show') {
    return { shows: [Object.assign({ ids: { tmdb: ref.tmdbId } }, extra)] };
  }
  return { shows: [{ ids: { tmdb: ref.tmdbId }, seasons: [{ number: ref.season, episodes: [Object.assign({ number: ref.episode }, extra)] }] }] };
}

/** A Trakt item ({ type, movie | show | episode + show }) as a titleRef, or null without a TMDB id */
function refOf(item) {
  if (item.movie) {
    return item.movie.ids && item.movie.ids.tmdb ? { kind: 'movie', tmdbId: item.movie.ids.tmdb, title: item.movie.title } : null;
  }
  if (item.episode && item.show) {
    return item.show.ids && item.show.ids.tmdb && item.episode.season !== undefined ?
      { kind: 'episode', tmdbId: item.show.ids.tmdb, season: item.episode.season, episode: item.episode.number, title: item.show.title } : null;
  }
  if (item.show) {
    return item.show.ids && item.show.ids.tmdb ? { kind: 'show', tmdbId: item.show.ids.tmdb, title: item.show.title } : null;
  }
  return null;
}

// ── what we sent to Trakt (so a sync doesn't bring it back as new) ──────────

async function sentOf(profileId) {
  var sent = (await playpex.store.get('sent:' + profileId)) || {},
    oldest = Date.now() - SENT_DAYS * 24 * 60 * 60 * 1000;
  Object.keys(sent).forEach(function (k) {
    if (sent[k] < oldest) {
      delete sent[k];
    }
  });
  return sent;
}

async function remember(profileId, what) {
  var sent = await sentOf(profileId);
  sent[what] = Date.now();
  await playpex.store.set('sent:' + profileId, sent);
}

async function syncMode(ctx) {
  return (await playpex.settings.get('sync', ctx)) || 'all';
}

// ── metadata.details: Trakt's rating ────────────────────────────────────────

playpex.hooks.on('metadata.details', async function (input) {
  var t = input.title;
  if ((t.kind !== 'movie' && t.kind !== 'show') || !(await playpex.secrets.get('traktClientId'))) {
    return {};
  }
  // Trakt takes an IMDb id where it takes its own
  var id = t.imdbId || input.details.imdbId;
  if (!id) {
    return {};
  }
  var ratings = await cached('/' + (t.kind === 'movie' ? 'movies' : 'shows') + '/' + id + '/ratings');
  if (!ratings || !ratings.votes) {
    return {};
  }
  var url = 'https://trakt.tv/search/imdb/' + id;
  return {
    ratings: [{ source: 'Trakt', value: Math.round(ratings.rating * 10) / 10, max: 10, votes: ratings.votes, url: url }],
    links: [{ label: 'On Trakt', url: url }]
  };
});

// ── scrobbling ──────────────────────────────────────────────────────────────

var playing = {};    // profile id → { key, state: 'playing' | 'paused' | 'stopped' }

async function scrobble(e, action) {
  var ctx = e.context, t = e.data && e.data.title;
  if (!ctx || !ctx.profile || !t || !t.tmdbId || (t.kind !== 'movie' && t.kind !== 'episode')) {
    return;
  }
  if (!(await playpex.settings.get('scrobble', ctx))) {
    return;
  }
  var accessToken = await token(ctx.profile.id);
  if (!accessToken) {
    return;
  }
  var k = key(t), now = playing[ctx.profile.id];
  if (action === 'resume') {
    // a progress report: only news after a pause, or a play we never heard start
    if (now && now.key === k && now.state === 'playing') {
      return;
    }
    action = 'start';
  }
  if (action === 'stop' && now && now.key === k && now.state === 'stopped') {
    return;    // finished, then left: one stop
  }
  var progress = e.data.duration > 0 ? Math.min(100, Math.round(e.data.position / e.data.duration * 1000) / 10) : 0;
  var item = t.kind === 'movie' ? { movie: { ids: { tmdb: t.tmdbId } } } :
    { show: { ids: { tmdb: t.tmdbId } }, episode: { season: t.season, number: t.episode } };
  await trakt('/scrobble/' + action, { method: 'POST', token: accessToken, body: Object.assign(item, { progress: progress }) });
  playing[ctx.profile.id] = { key: k, state: action === 'start' ? 'playing' : action === 'pause' ? 'paused' : 'stopped' };
  // Trakt counts a stop past 80 % as watched: its history now has it
  if (action === 'stop' && progress >= 80) {
    await remember(ctx.profile.id, 'watched:' + k);
  }
}

playpex.events.on('playback.started', function (e) { return scrobble(e, 'start'); });
playpex.events.on('playback.progress', function (e) { return scrobble(e, 'resume'); });
playpex.events.on('playback.paused', function (e) { return scrobble(e, 'pause'); });
playpex.events.on('playback.finished', function (e) { return scrobble(e, 'stop'); });
playpex.events.on('playback.ended', function (e) { return scrobble(e, 'stop'); });

// ── the profile's own changes → Trakt ───────────────────────────────────────

async function send(e, what, path, extra) {
  var ctx = e.context, t = e.data && e.data.title;
  if (!ctx || !ctx.profile || !t || !t.tmdbId) {
    return;
  }
  var mode = await syncMode(ctx);
  if (mode === 'off' || (what !== 'watchlist' && mode !== 'all')) {
    return;
  }
  var accessToken = await token(ctx.profile.id);
  if (!accessToken) {
    return;
  }
  // an episode on the watch list is its show
  var ref = what === 'watchlist' && t.kind === 'episode' ? { kind: 'show', tmdbId: t.tmdbId } : t;
  if (what === 'watched' && path === '/sync/history') {
    var sent = await sentOf(ctx.profile.id);
    if (sent['watched:' + key(ref)]) {
      return;    // scrobbled: Trakt has it
    }
  }
  await trakt(path, { method: 'POST', token: accessToken, body: body(ref, extra) });
  await remember(ctx.profile.id, what + ':' + key(ref));
}

playpex.events.on('watchlist.added', function (e) { return send(e, 'watchlist', '/sync/watchlist'); });
playpex.events.on('watchlist.removed', function (e) { return send(e, 'watchlist', '/sync/watchlist/remove'); });
playpex.events.on('watched.set', function (e) {
  return send(e, 'watched', '/sync/history', { watched_at: new Date(e.time || Date.now()).toISOString() });
});
playpex.events.on('watched.cleared', function (e) { return send(e, 'watched', '/sync/history/remove'); });
playpex.events.on('rating.set', function (e) {
  var rating = e.data && e.data.rating;
  return rating ? send(e, 'rating', '/sync/ratings', { rating: rating }) : send(e, 'rating', '/sync/ratings/remove');
});

// ── sync: Trakt → Playpex ───────────────────────────────────────────────────

/** Every page (≤ MAX_PAGES) of a paged list */
async function pages(path, accessToken) {
  var out = [], page = 1, count = 1;
  while (page <= count && page <= MAX_PAGES) {
    var r = await trakt(path + (path.indexOf('?') === -1 ? '?' : '&') + 'limit=100&page=' + page, { token: accessToken });
    out = out.concat(r && r.body || []);
    count = r ? r.pages : 0;
    page++;
  }
  return out;
}

async function syncWatchlist(profileId, accessToken, summary) {
  var lists = await Promise.all([pages('/sync/watchlist/movies', accessToken), pages('/sync/watchlist/shows', accessToken)]);
  var onTrakt = {};
  lists[0].concat(lists[1]).map(refOf).filter(Boolean).forEach(function (ref) { onTrakt[key(ref)] = ref; });
  var local = {};
  (await playpex.watchlist.list(profileId)).forEach(function (entry) {
    var ref = entry.title.kind === 'episode' ? { kind: 'show', tmdbId: entry.title.tmdbId } : entry.title;
    local[key(ref)] = ref;
  });
  var known = await playpex.store.get('known:' + profileId);    // what Trakt had at the last sync; null: never synced
  var seen = {};
  (known || []).forEach(function (k) { seen[k] = true; });
  var push = [];
  for (var k in onTrakt) {
    if (!local[k] && !seen[k]) {
      await playpex.watchlist.add(profileId, onTrakt[k]);     // added on Trakt
      summary.watchlist++;
    }
  }
  for (k in local) {
    if (seen[k] && !onTrakt[k]) {
      await playpex.watchlist.remove(profileId, local[k]);    // removed on Trakt
      summary.removed++;
    } else if (!onTrakt[k] && !seen[k]) {
      push.push(local[k]);                                     // Playpex's, never sent (first sync, a failed send)
    }
  }
  if (push.length) {
    var movies = push.filter(function (r) { return r.kind === 'movie'; }), shows = push.filter(function (r) { return r.kind === 'show'; });
    await trakt('/sync/watchlist', { method: 'POST', token: accessToken, body: {
      movies: movies.map(function (r) { return { ids: { tmdb: r.tmdbId } }; }),
      shows: shows.map(function (r) { return { ids: { tmdb: r.tmdbId } }; })
    } });
    push.forEach(function (r) { onTrakt[key(r)] = r; });
    summary.sent += push.length;
  }
  await playpex.store.set('known:' + profileId, Object.keys(onTrakt));
}

async function syncHistory(profileId, accessToken, since, summary) {
  var start = encodeURIComponent(since);
  var lists = await Promise.all([pages('/sync/history/movies?start_at=' + start, accessToken), pages('/sync/history/episodes?start_at=' + start, accessToken)]);
  var sent = await sentOf(profileId), done = {};
  for (var item of lists[0].concat(lists[1])) {
    var ref = refOf(item);
    if (!ref || sent['watched:' + key(ref)] || done[key(ref)]) {
      continue;
    }
    done[key(ref)] = true;
    await playpex.watched.set(profileId, ref, item.watched_at ? { at: item.watched_at } : {});
    summary.watched++;
  }
}

async function syncRatings(profileId, accessToken, since, summary) {
  var lists = await Promise.all([pages('/sync/ratings/movies', accessToken), pages('/sync/ratings/shows', accessToken)]);
  var sent = await sentOf(profileId);
  for (var item of lists[0].concat(lists[1])) {
    var ref = refOf(item);
    if (!ref || !item.rating || sent['rating:' + key(ref)] || (since && item.rated_at && item.rated_at <= since)) {
      continue;
    }
    await playpex.ratings.set(profileId, ref, item.rating);
    summary.ratings++;
  }
}

/** One profile's sync (when its interval is up, or `force`): what it changed */
async function syncProfile(profileId, granted, force) {
  var ctx = { profile: { id: profileId } };
  var summary = { profile: profileId, watchlist: 0, removed: 0, sent: 0, watched: 0, ratings: 0, skipped: null };
  var mode = await syncMode(ctx);
  if (mode === 'off') {
    summary.skipped = 'off';
    return summary;
  }
  var last = await playpex.store.get('last:' + profileId),
    every = INTERVALS[await playpex.settings.get('interval')] || INTERVALS['1h'];
  if (!force && last && Date.now() - last.at < every) {
    summary.skipped = 'not due';
    return summary;
  }
  var accessToken = await token(profileId);
  if (!accessToken) {
    summary.skipped = 'not linked';
    return summary;
  }
  var startedAt = new Date().toISOString(),
    since = last ? last.since : new Date(Date.now() - FIRST_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  if (granted.watchlist[profileId]) {
    await syncWatchlist(profileId, accessToken, summary);
  }
  if (mode === 'all' && granted.watched[profileId]) {
    await syncHistory(profileId, accessToken, since, summary);
  }
  if (mode === 'all' && granted.ratings[profileId]) {
    await syncRatings(profileId, accessToken, last ? last.since : null, summary);
  }
  await playpex.store.set('last:' + profileId, { at: Date.now(), since: startedAt });
  var added = summary.watchlist + summary.watched + summary.ratings;
  if (added && mode === 'all' && (await playpex.settings.get('notifyImports', ctx)) !== false) {
    var parts = [];
    if (summary.watchlist) {
      parts.push(summary.watchlist + (summary.watchlist === 1 ? ' title' : ' titles') + ' added to your watch list');
    }
    if (summary.watched) {
      parts.push(summary.watched + ' watched');
    }
    if (summary.ratings) {
      parts.push(summary.ratings + (summary.ratings === 1 ? ' rating' : ' ratings'));
    }
    await playpex.notify.send([profileId], { text: 'Trakt: ' + parts.join(', '), tone: 'info', key: 'sync' });
  }
  return summary;
}

/** Every profile granted a write scope, each synced in turn (one failing doesn't stop the others) */
async function syncAll(force) {
  var lists = await Promise.all(['write.watchlist', 'write.watched', 'write.ratings'].map(function (p) { return playpex.profiles.list(p); }));
  var granted = { watchlist: {}, watched: {}, ratings: {} }, ids = {};
  ['watchlist', 'watched', 'ratings'].forEach(function (scope, i) {
    lists[i].forEach(function (p) {
      granted[scope][p.id] = true;
      ids[p.id] = true;
    });
  });
  var out = [];
  for (var id in ids) {
    try {
      out.push(await syncProfile(id, granted, force));
    } catch (err) {
      playpex.log.warn('sync of a profile failed: ' + err.message, { code: err.code || null });
      out.push({ profile: id, error: err.code || 'FAILED' });
    }
  }
  return out;
}

playpex.schedule.every('sync', '15m', function () { return syncAll(false); }, { atStart: true });

playpex.data('syncNow', async function () {
  var results = await syncAll(true);
  var synced = results.filter(function (r) { return !r.error && !r.skipped; }).length,
    failed = results.filter(function (r) { return r.error; }).length;
  var text = !results.length ? 'No profile may be synced yet: grant one its watch list (Profiles)' :
    synced ? 'Synced ' + synced + (synced === 1 ? ' profile' : ' profiles') + (failed ? ', ' + failed + ' failed' : '') :
    failed ? 'The sync failed: see Activity' : 'Nothing to sync: link an account first (Accounts)';
  return { data: { results: results }, effects: [{ type: 'toast', text: text, tone: failed ? 'error' : 'success' }] };
});

// ── rows for the Movies and TV shows sections ───────────────────────────────

async function cards(items, kind) {
  var refs = items.map(function (i) { return i[kind === 'movie' ? 'movie' : 'show'] || i; })
    .filter(function (x) { return x && x.ids && x.ids.tmdb; }).slice(0, 20);
  var details = await Promise.all(refs.map(function (x) {
    return (kind === 'movie' ? playpex.tmdb.movie(x.ids.tmdb) : playpex.tmdb.tv(x.ids.tmdb)).catch(function () { return null; });
  }));
  return refs.map(function (x, i) {
    var d = details[i];
    if (!d || !d.poster_path) {
      return null;
    }
    return {
      key: 'trakt:' + kind + ':' + x.ids.tmdb,
      title: d.title || d.name || x.title,
      subtitle: x.year ? String(x.year) : undefined,
      image: playpex.tmdb.image(d.poster_path, 'w342'),
      intent: { screen: kind === 'movie' ? 'core.movie' : 'core.show', params: { id: x.ids.tmdb } }
    };
  }).filter(Boolean);
}

async function rows(kind, args, ctx) {
  var c = args.context || {};
  if (c.query || (c.filters && Object.keys(c.filters).some(function (k) { return c.filters[k] !== null && c.filters[k] !== '' && c.filters[k] !== 0; }))) {
    return { data: [] };     // a search / filters stand in for the section's rows
  }
  if (!(await playpex.secrets.get('traktClientId'))) {
    return { data: [] };
  }
  var plural = kind === 'movie' ? 'movies' : 'shows', out = [];
  var trending = await cached('/' + plural + '/trending?limit=20').catch(function () { return null; });
  if (trending && trending.length) {
    var items = await cards(trending, kind);
    if (items.length) {
      out.push({ key: 'trakt:trending-' + plural, title: 'Trending on Trakt', items: items });
    }
  }
  var accessToken = ctx.profile ? await token(ctx.profile.id) : null;
  if (accessToken) {
    var r = await trakt('/recommendations/' + plural + '?limit=20&ignore_collected=true', { token: accessToken }).catch(function () { return null; });
    var recommended = r && r.body ? await cards(r.body, kind) : [];
    if (recommended.length) {
      out.push({ key: 'trakt:recommended-' + plural, title: 'Recommended for you on Trakt', items: recommended });
    }
  }
  return { data: out };
}

playpex.data('movieRows', function (args, ctx) { return rows('movie', args, ctx); });
playpex.data('showRows', function (args, ctx) { return rows('show', args, ctx); });
