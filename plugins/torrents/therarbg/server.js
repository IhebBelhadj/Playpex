// TheRARBG (therarbg.to): the community successor of RARBG, which shut down in
// 2023. Movie and episode torrents for Play and "Find releases" lists. Runs in
// the server's sandbox (docs/plugins/server.md). Educational project:
// streaming copyrighted content via torrents may be illegal where you live.
//
//   play.collect        an episode: "<show> SxxEyy" + "<show> Sxx" (its season's packs);
//                       a movie: "<title> <year>" in Movies. Kept: what the core's strict
//                       matcher (playpex.names.matches) says is that title
//   releases.providers  movies / shows: the category Movies / TV, most seeded first, 50 a page
//
// JSON mode of its search page (/get-posts/…?format=json). Fields: n name,
// h info hash, s size (bytes), se seeders (the site's own dropdown mislabels
// it), le leechers, c category, a added (unix s). Seed counts can be months
// stale. Never put the resolution in the keywords: the site then ranks by
// name, not by seeders.

var MIRRORS = ['https://therarbg.to', 'https://therarbg.com'];
var HASH = /^[0-9a-fA-F]{40}$/;
var MAX_SOURCES = 50;

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

/** path + query on the first mirror that answers: { results, links } */
function get(path) {
  var i = 0;
  function attempt() {
    return playpex.http.request({ url: MIRRORS[i] + path, responseType: 'json' }).then(function (res) {
      if (res.status !== 200 || !res.body || typeof res.body !== 'object') {
        throw new Error('TheRARBG answered HTTP ' + res.status);
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

/** The plain keywords search (every category mixed) */
function search(keywords) {
  return get('/get-posts/?' + qs({ keywords: keywords, format: 'json' })).then(function (data) {
    return data.results || [];
  });
}

/** One category's search */
function searchIn(keywords, category) {
  return get('/get-posts/keywords:' + encodeURIComponent(keywords) + ':category:' + category + '/?format=json').then(function (data) {
    return data.results || [];
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

function sourcesOf(results, title) {
  var candidates = results.filter(function (r) { return r.n && HASH.test(String(r.h || '')); });
  if (!candidates.length) {
    return [];
  }
  return playpex.names.matches(candidates.map(function (r) { return String(r.n).slice(0, 1000); }), title).then(function (kinds) {
    return best(candidates.filter(function (r, i) { return kinds[i]; }).map(function (r) {
      return { kind: 'magnet', infoHash: r.h.toLowerCase(), label: String(r.n).slice(0, 200), size: Number(r.s) || 0, seeds: Number(r.se) || 0 };
    }));
  });
}

playpex.hooks.on('play.collect', function (input) {
  var t = input.title, name = words(t.title);
  if (!name) {
    return [];
  }
  if (t.kind === 'episode') {
    var episode = search(name + ' S' + pad(t.season) + 'E' + pad(t.episode)),
      packs = search(name + ' S' + pad(t.season)).catch(function () { return []; });
    return Promise.all([episode, packs]).then(function (lists) {
      return sourcesOf(lists[0].concat(lists[1]).filter(function (r) { return /tv/i.test(r.c || ''); }), t);
    });
  }
  if (t.kind === 'movie') {
    return searchIn(name + (t.year ? ' ' + t.year : ''), 'Movies').then(function (results) {
      return sourcesOf(results.filter(function (r) { return r.c === 'Movies'; }), t);
    });
  }
  return [];
});

var CATEGORIES = { movie: 'Movies', show: 'TV' };

playpex.hooks.on('releases.providers', function (input) {
  var category = CATEGORIES[input.kind];
  if (!category) {
    return { releases: [], last: true };
  }
  var filters = 'order:-se:category:' + category, q = words(input.query);
  if (q) {
    filters = 'keywords:' + encodeURIComponent(q) + ':' + filters;
  }
  return get('/get-posts/' + filters + '/?' + qs({ format: 'json', page: input.page > 1 ? input.page : null })).then(function (data) {
    if (!Array.isArray(data.results)) {
      throw new Error('TheRARBG: unexpected answer');
    }
    return {
      releases: data.results.filter(function (r) { return r.n && HASH.test(String(r.h || '')) && r.c === category; }).map(function (r) {
        var out = { title: String(r.n).slice(0, 300), infoHash: r.h.toLowerCase(), seeds: Number(r.se) || 0, peers: Number(r.le) || 0,
          size: Number(r.s) || 0 };
        if (Number(r.a) > 0) {
          out.uploadedAt = new Date(Number(r.a) * 1000).toISOString();
        }
        return out;
      }),
      last: !(data.links && data.links.next)
    };
  });
});
