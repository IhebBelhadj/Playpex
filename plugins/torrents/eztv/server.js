// EZTV: TV episode torrents for Play and a "Find releases" list, from its
// official API. Runs in the server's sandbox (docs/plugins/server.md).
// Educational project: streaming copyrighted content via torrents may be
// illegal where you live.
//
//   play.collect        an episode's torrents (and its season's packs) by the show's IMDb id
//   releases.providers  shows: one show's torrents (the list's IMDb id), else the latest uploads
//
// The API has no season / episode filter: a show's pages are read once and
// kept 30 min. Its IMDb lookup sometimes answers another show ("Breaking
// Brad" for Breaking Bad): Play keeps only names the core's strict matcher
// (playpex.names.matches) says are that episode or its season.

var MIRRORS = ['https://eztvx.to', 'https://eztv.wf', 'https://eztv.tf'];
var PAGE_SIZE = 100;
var MAX_PAGES = 15;
var CACHE_MS = 30 * 60 * 1000;
var HASH = /^[0-9a-f]{40}$/;
var MAX_SOURCES = 50;

var cache = {};

function qs(params) {
  return Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
}

/** imdbId: digits only, or null for the site's latest torrents */
function getPage(imdbId, page) {
  var i = 0, params = { limit: PAGE_SIZE, page: page };
  if (imdbId) {
    params.imdb_id = imdbId;
  }
  function attempt() {
    return playpex.http.request({ url: MIRRORS[i] + '/api/get-torrents?' + qs(params), responseType: 'json' }).then(function (res) {
      if (res.status !== 200 || !res.body || typeof res.body !== 'object') {
        throw new Error('EZTV answered HTTP ' + res.status);
      }
      return res.body;
    }).catch(function (err) {
      if (++i < MIRRORS.length) {
        return attempt();
      }
      throw err;
    });
  }
  return attempt();
}

function fetchAll(imdbId) {
  var all = [];
  function next(page) {
    return getPage(imdbId, page).then(function (data) {
      var torrents = data.torrents || [];
      all = all.concat(torrents);
      var total = Number(data.torrents_count) || 0;
      if (torrents.length === PAGE_SIZE && all.length < total && page < MAX_PAGES) {
        return next(page + 1);
      }
      return all;
    });
  }
  return next(1);
}

/** Every torrent of a show (digits of its IMDb id), kept 30 min (failures aren't kept) */
function showTorrents(imdbId) {
  var hit = cache[imdbId];
  if (hit && hit.expires > Date.now()) {
    return hit.torrents;
  }
  var torrents = fetchAll(imdbId);
  cache[imdbId] = { torrents: torrents, expires: Date.now() + CACHE_MS };
  torrents.catch(function () { delete cache[imdbId]; });
  return torrents;
}

function nameOf(t) {
  return String(t.title || t.filename || '');
}

function hashOf(t) {
  return String(t.hash || '').toLowerCase();
}

function wordsOf(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** every word of the keywords appears in the release name (punctuation ignored) */
function matchesWords(name, words) {
  if (!words.length) {
    return true;
  }
  var have = ' ' + wordsOf(name).join(' ') + ' ';
  return words.every(function (w) { return have.indexOf(' ' + w + ' ') !== -1; });
}

function asRelease(t) {
  var out = {
    title: nameOf(t).slice(0, 300),
    infoHash: hashOf(t),
    seeds: Number(t.seeds) || 0,
    peers: Number(t.peers) || 0,
    size: Number(t.size_bytes) || 0
  };
  var added = Number(t.date_released_unix) || 0;
  if (added > 0) {
    out.uploadedAt = new Date(added * 1000).toISOString();
  }
  return out;
}

/** At most 50 (play.collect's limit): the best in the core's streaming order */
function best(sources) {
  if (sources.length <= MAX_SOURCES) {
    return sources;
  }
  return playpex.names.rank(sources.map(function (s, i) { return { name: s.label, seeds: s.seeds, i: i }; })).then(function (order) {
    return order.slice(0, MAX_SOURCES).map(function (o) { return sources[o.i]; });
  });
}

playpex.hooks.on('play.collect', function (input) {
  var t = input.title;
  if (t.kind !== 'episode' || !t.imdbId) {
    return [];
  }
  return showTorrents(t.imdbId.replace(/^tt/, '')).then(function (torrents) {
    // episode 0 = a whole-season pack
    var candidates = torrents.filter(function (x) {
      var ep = Number(x.episode);
      return Number(x.season) === t.season && (ep === t.episode || ep === 0) && HASH.test(hashOf(x)) && nameOf(x);
    });
    if (!candidates.length) {
      return [];
    }
    return playpex.names.matches(candidates.map(function (x) { return nameOf(x).slice(0, 1000); }), t).then(function (kinds) {
      return best(candidates.filter(function (x, i) { return kinds[i]; }).map(function (x) {
        return {
          kind: 'magnet', infoHash: hashOf(x), label: nameOf(x).slice(0, 200),
          size: Number(x.size_bytes) || 0, seeds: Number(x.seeds) || 0
        };
      }));
    });
  });
});

// With the list's IMDb id: that show's torrents, filtered by the keywords,
// most seeded first, paged here. Without: the site's latest torrents page by
// page (it has no keyword search: keywords only filter each page).
playpex.hooks.on('releases.providers', function (input) {
  if (input.kind !== 'show') {
    return { releases: [], last: true };
  }
  var words = wordsOf(input.query),
    page = Math.max(1, input.page || 1),
    imdbId = input.title && input.title.imdbId;

  function kept(x) {
    return HASH.test(hashOf(x)) && matchesWords(nameOf(x), words);
  }

  if (imdbId) {
    return showTorrents(imdbId.replace(/^tt/, '')).then(function (torrents) {
      var list = torrents.filter(kept).map(asRelease).sort(function (a, b) { return b.seeds - a.seeds; });
      return { releases: list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), last: list.length <= page * PAGE_SIZE };
    });
  }
  return getPage(null, page).then(function (data) {
    var torrents = data.torrents || [];
    return {
      releases: torrents.filter(kept).map(asRelease),
      last: !(torrents.length === PAGE_SIZE && page * PAGE_SIZE < (Number(data.torrents_count) || 0))
    };
  });
});
