// The Pirate Bay, through its JSON API (apibay.org, what thepiratebay.org's
// own page calls): movie and episode torrents for Play and "Find releases"
// lists. Runs in the server's sandbox (docs/plugins/server.md). Educational
// project: streaming copyrighted content via torrents may be illegal where
// you live.
//
//   play.collect        a movie: "<title> <year>"; an episode: "<show> SxxEyy" + "<show> Sxx".
//                       Kept: the kind's subcategories, and what the core's strict matcher
//                       (playpex.names.matches) says is that title
//   releases.providers  movies / shows: the top 100 of the kind's subcategories (by quality),
//                       or a search (≤ 100 results); no paging
//
// Fields: name, info_hash, seeders, leechers, size (bytes), added (unix s),
// category. No match answers one fake row with an all-zero info hash. Names
// come HTML-escaped ("Laurent Sky &amp; Julia Grandi").

var BASE = 'https://apibay.org';
var HASH = /^[0-9a-fA-F]{40}$/;
var NO_HASH = /^0+$/;
var MAX_SOURCES = 50;

// Subcategories: 201 Movies, 207 HD, 211 UHD/4k (not 202 DVDR images, 209 3D);
// 205 TV shows, 208 HD, 212 UHD/4k. Searches ask the parent category 200.
var KINDS = {
  movie: { all: ['201', '207', '211'], sd: '201', hd: '207', uhd: '211' },
  show: { all: ['205', '208', '212'], sd: '205', hd: '208', uhd: '212' }
};

function qs(params) {
  return Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function words(text) {
  return String(text || '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function unescape(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** path: '/q.php?…' or a precompiled top-100 list; its rows */
function get(path) {
  return playpex.http.request({ url: BASE + path, responseType: 'json' }).then(function (res) {
    if (res.status !== 200) {
      throw new Error('The Pirate Bay answered HTTP ' + res.status);
    }
    return Array.isArray(res.body) ? res.body : [];
  });
}

function query(keywords) {
  return get('/q.php?' + qs({ q: keywords, cat: '200' }));
}

/** Real rows of the kind's subcategories, each hash once */
function rowsOf(rows, kind) {
  var seen = {};
  return rows.filter(function (r) {
    var hash = String(r.info_hash || '');
    if (!HASH.test(hash) || NO_HASH.test(hash) || !r.name || KINDS[kind].all.indexOf(String(r.category)) === -1 || seen[hash]) {
      return false;
    }
    seen[hash] = true;
    return true;
  });
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
  var t = input.title, name = words(t.title), reads, kind;
  if (!name) {
    return [];
  }
  if (t.kind === 'movie') {
    kind = 'movie';
    reads = [query(name + (t.year ? ' ' + t.year : ''))];
  } else if (t.kind === 'episode') {
    kind = 'show';
    reads = [query(name + ' S' + pad(t.season) + 'E' + pad(t.episode)), query(name + ' S' + pad(t.season)).catch(function () { return []; })];
  } else {
    return [];
  }
  return Promise.all(reads).then(function (lists) {
    var rows = rowsOf([].concat.apply([], lists), kind);
    if (!rows.length) {
      return [];
    }
    return playpex.names.matches(rows.map(function (r) { return unescape(r.name).slice(0, 1000); }), t).then(function (kinds) {
      return best(rows.filter(function (r, i) { return kinds[i]; }).map(function (r) {
        return {
          kind: 'magnet', infoHash: r.info_hash.toLowerCase(), label: unescape(r.name).slice(0, 200),
          size: Number(r.size) || 0, seeds: Number(r.seeders) || 0, peers: Number(r.leechers) || 0
        };
      }));
    });
  });
});

/** The top-100 lists a quality filter reads; "any" merges the three */
function lists(kind, quality) {
  var k = KINDS[kind];
  return quality === '2160p' ? [k.uhd] : (quality === '1080p' || quality === '720p') ? [k.hd] : quality === 'SD' ? [k.sd] : k.all;
}

playpex.hooks.on('releases.providers', function (input) {
  if (!KINDS[input.kind] || input.page > 1) {
    return { releases: [], last: true };
  }
  var q = words(input.query),
    rows = q ? query(q) : Promise.all(lists(input.kind, input.filters && input.filters.quality).map(function (category) {
      return get('/precompiled/data_top100_' + category + '.json');
    })).then(function (all) { return [].concat.apply([], all); });

  return rows.then(function (found) {
    return {
      releases: rowsOf(found, input.kind).map(function (r) {
        var out = { title: unescape(r.name).slice(0, 300), infoHash: r.info_hash.toLowerCase(), seeds: Number(r.seeders) || 0,
          peers: Number(r.leechers) || 0, size: Number(r.size) || 0 };
        if (Number(r.added) > 0) {
          out.uploadedAt = new Date(Number(r.added) * 1000).toISOString();
        }
        return out;
      }),
      last: true
    };
  });
});
