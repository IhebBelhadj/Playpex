// The 18+ section as a plugin (docs/plugins-plan.md §7). Runs in the server's
// sandbox (docs/plugins/server.md); the TV draws it with the core's templates.
// Educational project: streaming copyrighted content via torrents may be
// illegal where you live.
//
// Data handlers and what the core sends them:
//   browse    catalog   { params, query, filters: { view, studio, period } }   the poster layout
//   rowPage   row page  { page, provider, row?, sort?, studio?, period?, q? }  a paged row
//   title     title     { params: { provider, id } }                          one title
//   play      call      { provider, id }                                     its torrents → the core's player
//   releases  releases  { params: { q? }, query, filters, page }             the list layout (screens releases, find)
//   searchFilter        { slot, context: { query } }                         the search page's "18+" chip
//
// The layout (posters or list) is the "View" filter of both screens, kept per
// profile in the store: the section opens the profile's last one. Catalog
// from TMDB (adult films through their studios) or ThePornDB, the profile's
// choice; releases from The Pirate Bay's and TheRARBG's XXX categories, most
// seeded first. Plays never touch the profile's library: the core sets
// tracking 'none' for an adults plugin, and so does this one.

var TMDB = 'https://api.themoviedb.org/3';
var TMDB_IMG = 'https://image.tmdb.org/t/p/';
var TPDB = 'https://api.theporndb.net';
var APIBAY = 'https://apibay.org';
var THERARBG = ['https://therarbg.to', 'https://therarbg.com'];
var TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce'];
var CACHE_MS = 60 * 60 * 1000;
var PAGE_SIZE = 20;
var MAX_PAGE = 500;            // TMDB answers no page past 500

// ── small helpers ───────────────────────────────────────────────────────────

function qs(params) {
  return Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
}

var cache = {};

/** A GET answer as JSON, cached an hour (failures aren't kept) */
function getJson(url, headers) {
  var hit = cache[url];
  if (hit && hit.expires > Date.now()) {
    return hit.value;
  }
  var value = playpex.http.request({ url: url, responseType: 'json', headers: headers || {} }).then(function (res) {
    if (res.status !== 200) {
      throw new Error(url.split('?')[0] + ' answered HTTP ' + res.status);
    }
    return res.body;
  });
  cache[url] = { value: value, expires: Date.now() + CACHE_MS };
  value.catch(function () { delete cache[url]; });
  return value;
}

/** The first mirror that answers */
function mirrored(bases, path) {
  var i = 0;
  function attempt() {
    return getJson(bases[i] + path).catch(function (err) {
      if (++i < bases.length) {
        return attempt();
      }
      throw err;
    });
  }
  return attempt();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function magnetOf(hash, name) {
  return 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(name) +
    TRACKERS.map(function (t) { return '&tr=' + encodeURIComponent(t); }).join('');
}

function clip(text, n) {
  text = String(text || '');
  return text.length > n ? text.slice(0, n - 1) + '…' : text;
}

// ── release names ───────────────────────────────────────────────────────────

// "Heatwave Vol. 2 [Vixen 2026] XXX WEB-DL 1080p SPLIT SCENES MP4-P2P [XC]" →
// title "Heatwave Vol. 2", studio "Vixen", year 2026
var JUNK = /\b(xxx|2160p|1080p|720p|480p|4k|uhd|web.?dl|webrip|hdrip|bluray|dvdrip|split.?scenes?|mp4|mkv|wmv|x26[45]|h\.?26[45]|hevc|p2p|[-.](xc|trb|ktr|gush|wrb|nbq|xleech))\b/i;

function present(name) {
  var text = String(name).replace(/\.(mp4|mkv|avi|wmv)$/i, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  var studio = null, year = null;
  var bracket = text.match(/\[([^\]]+?)\s+((19|20)\d\d)\]/);
  if (bracket) {
    studio = bracket[1].trim();
    year = Number(bracket[2]);
  }
  var title = text.replace(/\[[^\]]*\]/g, ' ');
  var junk = title.search(JUNK);
  if (junk > 0) {
    title = title.slice(0, junk);
  }
  title = title.replace(/[\s\-–(]+$/, '').replace(/\s+/g, ' ').trim();
  return { title: title.length < 3 ? text : title, studio: studio, year: year };
}

// What plays in the TV's Chromium (as the core's episodes.js says it)
function describe(name) {
  var resolution = (name.match(/\b(2160p|1080p|720p|480p)\b/i) || [])[1];
  if (!resolution && /\b(4k|uhd)\b/i.test(name)) {
    resolution = '2160p';
  }
  resolution = resolution ? resolution.toLowerCase() : 'SD';
  var hevc = /\b(x265|h\.?265|hevc)\b/i.test(name),
    tenBit = /\b10.?bit\b/i.test(name),
    xvid = /\b(xvid|divx)\b/i.test(name),
    audio = 'unknown';
  if (/\b(ddp?\s?\d|ddp|dd\+|e-?ac-?3|ac-?3|eac3|truehd|atmos|dts(-?hd)?)\b/i.test(name)) {
    audio = 'unsupported';
  } else if (/\b(aac|opus|mp3)/i.test(name)) {
    audio = 'supported';
  }
  return {
    quality: resolution,
    codec: hevc ? 'x265' : xvid ? 'xvid' : 'x264',
    audio: audio,
    playable: !hevc && !tenBit && !xvid && resolution !== '2160p',
    scenes: /\bsplit.?scenes?\b/i.test(name)
  };
}

function normalizeTitle(text) {
  return String(text).toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// null when the release isn't this film, else { yearMatch }: the name starts
// with the title (after a "[Studio]" tag), not followed by a sequel number; a
// release stating another year is another film
function match(name, title, year) {
  var normalized = normalizeTitle(String(name).replace(/^\s*(\[[^\]]*\]|\([^)]*\)|\s)+/, '')),
    wanted = normalizeTitle(title);
  if (!wanted) {
    return null;
  }
  var found = new RegExp('^' + escapeRegExp(wanted).replace(/ /g, ' +') + '(?= |$)(?! +([2-9]|[1-9]\\d)( |$))').test(normalized);
  if (!found) {
    return null;
  }
  var yearMatch = false,
    years = normalized.slice(wanted.length).match(/\b(19|20)\d\d\b/g) || [];
  if (year && years.length) {
    yearMatch = years.some(function (y) { return Math.abs(Number(y) - year) <= 1; });
    if (!yearMatch) {
      return null;
    }
  }
  return { yearMatch: yearMatch };
}

var AUDIO_RANK = { supported: 2, unknown: 1, unsupported: 0 },
  RESOLUTION_RANK = { '1080p': 3, '720p': 2, '480p': 1, 'SD': 1, '2160p': 0 },
  HEALTHY_SEEDS = 10;

function compare(a, b) {
  return (b.playable - a.playable) ||
    (AUDIO_RANK[b.audio] - AUDIO_RANK[a.audio]) ||
    ((b.seeds >= HEALTHY_SEEDS) - (a.seeds >= HEALTHY_SEEDS)) ||
    (a.scenes - b.scenes) ||
    (b.yearMatch - a.yearMatch) ||
    ((RESOLUTION_RANK[b.quality] || 0) - (RESOLUTION_RANK[a.quality] || 0)) ||
    (b.seeds - a.seeds);
}

// ── torrent sources (XXX categories) ────────────────────────────────────────

// The Pirate Bay's porn subcategories that hold films (not DVDR images, pictures, games)
var PIRATEBAY_FILMS = ['501', '505', '506', '507'];

// Names come HTML-escaped ("Laurent Sky &amp; Julia Grandi", "that&rsquo;s")
var ENTITIES = { quot: '"', apos: '\'', lt: '<', gt: '>', nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…',
  ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', ouml: 'ö', uuml: 'ü', auml: 'ä', ccedil: 'ç', ntilde: 'ñ' };

function unescapeHtml(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (all, e) {
    if (e[0] === '#') {
      var code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return e.toLowerCase() === 'amp' ? '&' : ENTITIES[e.toLowerCase()] || all;
  });
}

function words(text) {
  return String(text || '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function fromPirateBay(r) {
  var hash = r.info_hash.toLowerCase(), name = unescapeHtml(r.name);
  return { provider: 'The Pirate Bay', name: name, hash: hash, seeds: Number(r.seeders) || 0, peers: Number(r.leechers) || 0,
    size: Number(r.size) || 0, added: Number(r.added) || 0 };
}

/** Its films: the top 100 of `category` (no keywords) or a search (≤ 100); no paging */
function pirateBay(keywords, category) {
  var q = words(keywords);
  var path = q ? '/q.php?' + qs({ q: q, cat: category }) : '/precompiled/data_top100_' + category + '.json';
  return getJson(APIBAY + path).then(function (list) {
    var seen = {};
    return {
      results: (Array.isArray(list) ? list : []).filter(function (r) {
        if (!r.info_hash || /^0+$/.test(r.info_hash) || PIRATEBAY_FILMS.indexOf(String(r.category)) === -1 || seen[r.info_hash]) {
          return false;
        }
        seen[r.info_hash] = true;
        return true;
      }).map(fromPirateBay),
      hasMore: false
    };
  });
}

/** TheRARBG's XXX category, most seeded first, 50 a page (never the resolution in the keywords: it then ranks by name) */
function theRarbg(keywords, page) {
  var filters = 'order:-se:category:XXX', q = words(keywords);
  if (q) {
    filters = 'keywords:' + encodeURIComponent(q) + ':' + filters;
  }
  return mirrored(THERARBG, '/get-posts/' + filters + '/?' + qs({ format: 'json', page: page > 1 ? page : null })).then(function (data) {
    if (!data || !Array.isArray(data.results)) {
      throw new Error('TheRARBG: unexpected answer');
    }
    return {
      results: data.results.filter(function (r) { return r.h && r.c === 'XXX'; }).map(function (r) {
        return { provider: 'TheRARBG', name: r.n, hash: r.h.toLowerCase(), seeds: Number(r.se) || 0, peers: Number(r.le) || 0,
          size: Number(r.s) || 0, added: Number(r.a) || 0 };
      }),
      hasMore: !!(data.links && data.links.next)
    };
  });
}

var SOURCES = [
  { id: 'piratebay', name: 'The Pirate Bay', paged: false, list: function (c) {
    // its own subcategories narrow the top 100 by resolution
    var category = c.quality === '2160p' ? '507' : (c.quality === '1080p' || c.quality === '720p') ? '505' : '500';
    return pirateBay(c.q, category);
  } },
  { id: 'therarbg', name: 'TheRARBG', paged: true, list: function (c) { return theRarbg(c.q, c.page); } }
];

/** One film's torrents from both sources, matched by title (+ year) and ranked for streaming */
function findTorrents(title, year) {
  var q = words(title);
  var reads = [
    getJson(APIBAY + '/q.php?' + qs({ q: q, cat: '500' })).then(function (list) {
      return (Array.isArray(list) ? list : []).filter(function (r) {
        return r.info_hash && !/^0+$/.test(r.info_hash) && PIRATEBAY_FILMS.indexOf(String(r.category)) !== -1;
      }).map(fromPirateBay);
    }),
    mirrored(THERARBG, '/get-posts/keywords:' + encodeURIComponent(q) + ':category:XXX/?format=json').then(function (data) {
      return ((data && data.results) || []).filter(function (r) { return r.h && r.c === 'XXX'; }).map(function (r) {
        return { provider: 'TheRARBG', name: r.n, hash: r.h.toLowerCase(), seeds: Number(r.se) || 0, size: Number(r.s) || 0 };
      });
    })
  ];
  return Promise.all(reads.map(function (p) {
    return p.then(function (v) { return { ok: v }; }, function (err) { return { error: err.message }; });
  })).then(function (results) {
    var byHash = {}, errors = [];
    results.forEach(function (r) {
      if (r.error) {
        errors.push(r.error);
        return;
      }
      r.ok.forEach(function (t) {
        var found = match(t.name, title, year);
        if (found && (!byHash[t.hash] || t.seeds > byHash[t.hash].seeds)) {
          byHash[t.hash] = Object.assign(t, describe(t.name), found);
        }
      });
    });
    if (errors.length) {
      playpex.log.warn('torrent search errors: ' + errors.join('; '));
    }
    var list = Object.keys(byHash).map(function (h) { return byHash[h]; });
    list.sort(compare);
    return { torrents: list, failed: errors.length === results.length };
  });
}

function notesOf(t) {
  var p = present(t.name), notes = [];
  if (p.studio) notes.push(p.studio);
  if (p.year) notes.push(String(p.year));
  if (t.scenes) notes.push('Split scenes');
  if (t.audio === 'unsupported') notes.push('Probably no sound');
  else if (!t.playable) notes.push('May not play');
  notes.push(clip(t.provider, 80));
  return notes.slice(0, 6);
}

// ── catalogs ────────────────────────────────────────────────────────────────

// TMDB lists adult films (posters, cast) but has no adult filter or genres:
// they're reached through their studios (production companies, checked
// Oct 2026: each lists ≥ 40 adult titles with posters), and searches keep
// only `adult` results
var TMDB_STUDIOS = [
  ['8552', 'Brazzers'], ['97168', 'Vixen'], ['63844', 'Blacked'], ['72478', 'Tushy'], ['6463', 'Evil Angel'],
  ['6112', 'Digital Playground'], ['6258', 'Dorcel'], ['6316', 'Naughty America'], ['15887', 'Reality Kings'],
  ['33400', 'Jules Jordan Video'], ['6886', 'Elegant Angel'], ['6122', 'New Sensations'], ['5788', 'Private'],
  ['5979', 'Vivid Entertainment'], ['120963', 'Deeper'], ['103790', 'Blacked Raw'], ['117838', 'Tushy Raw'],
  ['97187', 'Pure Taboo'], ['114045', 'Adult Time'], ['6978', 'Girlfriends Films'], ['10294', 'Sweetheart Video'],
  ['6115', 'Hustler Video'], ['56675', 'Bang Bros'], ['107132', 'Mofos'], ['46264', 'Team Skeet'], ['8248', 'Devil\'s Film'],
  ['8027', 'Lethal Hardcore'], ['6228', 'Zero Tolerance'], ['6121', 'Digital Sin'], ['65222', 'Mile High Xtreme'],
  ['32777', 'Erotica X'], ['99678', 'Dark X'], ['111525', 'MissaX'], ['122166', 'Bellesa Films'], ['168340', 'Slayed'], ['8679', 'Kink']
].map(function (s) { return { id: s[0], name: s[1] }; });

// ThePornDB site ids (checked Oct 2026: exact name, each with ≥ 50 movies)
var TPDB_SITES = [
  ['92', 'Brazzers'], ['3372', 'Vixen'], ['200', 'Blacked'], ['3417', 'Tushy'], ['4611', 'Evil Angel'], ['347', 'Digital Playground'],
  ['6551', 'Marc Dorcel'], ['130', 'Naughty America'], ['20', 'Reality Kings'], ['1052', 'Elegant Angel'], ['202', 'Blacked Raw'],
  ['247', 'Tushy Raw'], ['3373', 'Deeper'], ['3374', 'New Sensations'], ['765', 'Private'], ['4633', 'Pure Taboo'], ['4432', 'Adult Time'],
  ['4628', 'Wicked'], ['36685', 'Hustler'], ['65', 'Mofos'], ['278', 'Team Skeet'], ['4404', 'Girlfriends Films'], ['263', 'Sweetheart Video'],
  ['1287', 'Zero Tolerance'], ['4635', 'Devil\'s Film'], ['3418', 'Digital Sin'], ['4376', 'Erotica X'], ['4388', 'Dark X'], ['6103', 'Slayed'],
  ['2274', 'MissaX'], ['353', 'Kink'], ['1001', 'Penthouse'], ['6497', 'Vivid'], ['1006', 'Lethal Hardcore'], ['1056', 'Adam & Eve']
].map(function (s) { return { id: s[0], name: s[1] }; });

var HOME_STUDIOS = 10;          // the first ones get a row on the home page

// A provider answers pages { items: [Item], page, totalPages };
// Item = { id, title, year, releaseDate, overview, poster, backdrop, rating, studio }
var PROVIDERS = {
  tmdb: {
    name: 'TMDB',
    secret: 'tmdbApiKey',
    sorts: ['popular', 'newest', 'rated'],
    periods: [['', 'Any time'], ['year', 'This year'], ['5y', 'Last 5 years'], ['classic', 'Before 2015']],
    studios: TMDB_STUDIOS,
    get: function (key, path, params) {
      return getJson(TMDB + path + '?' + qs(Object.assign({ api_key: key, language: 'en-US' }, params)));
    },
    item: function (r, studio) {
      var date = r.release_date || '';
      return {
        id: String(r.id), title: r.title || r.original_title || 'Untitled', year: date ? Number(date.slice(0, 4)) : null,
        releaseDate: date || null, overview: r.overview || '',
        poster: r.poster_path ? TMDB_IMG + 'w342' + r.poster_path : null,
        backdrop: r.backdrop_path ? TMDB_IMG + 'w1280' + r.backdrop_path : null,
        rating: r.vote_count >= 3 && r.vote_average ? r.vote_average : null, studio: studio || null
      };
    },
    page: function (data, studio, withPoster) {
      var self = this;
      return {
        items: (data.results || []).filter(function (r) { return r.adult && (!withPoster || r.poster_path); })
          .map(function (r) { return self.item(r, studio); }),
        page: data.page || 1,
        totalPages: Math.min(data.total_pages || 1, MAX_PAGE)
      };
    },
    period: function (period) {
      var year = new Date().getFullYear();
      return period === 'year' ? { 'primary_release_date.gte': year + '-01-01' } :
        period === '5y' ? { 'primary_release_date.gte': (year - 5) + '-01-01' } :
          period === 'classic' ? { 'primary_release_date.lte': '2014-12-31' } : {};
    },
    home: function () {
      return [['popular', 'Popular now'], ['newest', 'New releases'], ['rated', 'Top rated']].map(function (r) { return { row: r[0], title: r[1] }; })
        .concat(TMDB_STUDIOS.slice(0, HOME_STUDIOS).map(function (s) { return { row: 'studio:' + s.id, title: s.name }; }));
    },
    discover: function (key, o) {
      var self = this, studio = o.studio ? TMDB_STUDIOS.filter(function (s) { return s.id === String(o.studio); })[0] || { id: String(o.studio), name: '' } : null;
      var params = Object.assign({ include_adult: true, with_companies: studio ? studio.id : TMDB_STUDIOS.map(function (s) { return s.id; }).join('|'),
        page: Math.min(Math.max(1, o.page || 1), MAX_PAGE) }, this.period(o.period));
      if (!params['primary_release_date.lte']) {
        params['primary_release_date.lte'] = today();
      }
      if (o.sort === 'newest') {
        params.sort_by = 'primary_release_date.desc';
      } else if (o.sort === 'rated') {
        params.sort_by = 'vote_average.desc';
        params['vote_count.gte'] = 5;
      } else {
        params.sort_by = 'popularity.desc';
      }
      return this.get(key, '/discover/movie', params).then(function (data) { return self.page(data, studio, true); });
    },
    row: function (key, row, page) {
      var studio = /^studio:(\d+)$/.exec(row);
      return this.discover(key, studio ? { studio: studio[1], page: page } : { sort: row, page: page });
    },
    // TMDB ranks every regular match before the adult ones: they start after
    // the regular count. Our page n reads the TMDB page where they start + 2(n − 1), and the next
    search: function (key, o) {
      var self = this, q = String(o.q || '').trim(), page = Math.max(1, o.page || 1);
      if (!q) {
        return Promise.resolve({ items: [], page: 1, totalPages: 1 });
      }
      return Promise.all([
        this.get(key, '/search/movie', { query: q, include_adult: false, page: 1 }),
        this.get(key, '/search/movie', { query: q, include_adult: true, page: 1 })
      ]).then(function (counts) {
        var first = Math.floor((counts[0].total_results || 0) / PAGE_SIZE) + 1,
          last = Math.min(Math.ceil((counts[1].total_results || 0) / PAGE_SIZE), MAX_PAGE),
          from = first + (page - 1) * 2;
        if (from > last) {
          return { items: [], page: page, totalPages: page };
        }
        return Promise.all([from, from + 1].filter(function (p) { return p <= last; }).map(function (p) {
          return p === 1 ? counts[1] : self.get(key, '/search/movie', { query: q, include_adult: true, page: p });
        })).then(function (pages) {
          var seen = {}, period = self.period(o.period), items = [];
          pages.forEach(function (data) {
            self.page(data).items.forEach(function (it) {
              if (seen[it.id]) return;
              seen[it.id] = true;
              if (period['primary_release_date.gte'] && (!it.releaseDate || it.releaseDate < period['primary_release_date.gte'])) return;
              if (period['primary_release_date.lte'] && (!it.releaseDate || it.releaseDate > period['primary_release_date.lte'])) return;
              items.push(it);
            });
          });
          return { items: items, page: page, totalPages: Math.max(page, Math.ceil((last - first + 1) / 2)) };
        });
      });
    },
    title: function (key, id) {
      var self = this;
      return this.get(key, '/movie/' + encodeURIComponent(id), { append_to_response: 'credits' }).then(function (m) {
        if (!m.adult) {
          throw new Error('not an 18+ title');
        }
        var companies = (m.production_companies || []).map(function (c) { return { id: String(c.id), name: c.name }; }),
          known = companies.filter(function (c) { return TMDB_STUDIOS.some(function (s) { return s.id === c.id; }); })[0],
          credits = m.credits || {},
          director = (credits.crew || []).filter(function (c) { return c.job === 'Director'; })[0];
        return Object.assign(self.item(m, known || companies[0] || null), {
          runtime: m.runtime || null,
          performers: (credits.cast || []).slice(0, 20).map(function (c) {
            return { name: c.name, photo: c.profile_path ? TMDB_IMG + 'w185' + c.profile_path : null };
          }),
          director: director ? director.name : null,
          browsableStudio: known ? known.id : null
        });
      });
    }
  },

  // ThePornDB: covers, performers, studios ("sites"); only newest-first sorting
  // (checked Oct 2026), future-dated scraped entries dropped, one site per request
  theporndb: {
    name: 'ThePornDB',
    secret: 'theporndbApiKey',
    sorts: ['newest'],
    periods: [['', 'Any time'], ['year', 'This year'], ['last', 'Last year']],
    studios: TPDB_SITES,
    get: function (key, path, params) {
      return getJson(TPDB + path + (params ? '?' + qs(params) : ''), { Authorization: 'Bearer ' + key, Accept: 'application/json' });
    },
    pick: function (obj, paths) {
      for (var i = 0; i < paths.length; i++) {
        var v = paths[i].split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
        if (v) return v;
      }
      return null;
    },
    item: function (m) {
      var date = m.date || '';
      return {
        id: String(m.id || m._id), title: m.title || 'Untitled', year: date ? Number(String(date).slice(0, 4)) : null,
        releaseDate: date || null, overview: m.description || '',
        poster: this.pick(m, ['image', 'posters.medium', 'posters.large', 'poster']),
        backdrop: this.pick(m, ['posters.large', 'background.large', 'image']),
        rating: Number(m.rating) > 0 ? Number(m.rating) : null,
        studio: m.site && m.site.name ? { id: String(m.site.id), name: m.site.name } : null
      };
    },
    year: function (period) {
      var year = new Date().getFullYear();
      return period === 'year' ? year : period === 'last' ? year - 1 : null;
    },
    movies: function (key, params) {
      var self = this;
      return this.get(key, '/movies', Object.assign({ per_page: 30, orderBy: 'recently_released' }, params)).then(function (data) {
        var meta = data.meta || {};
        return {
          items: (data.data || []).map(function (m) { return self.item(m); })
            .filter(function (it) { return it.poster && (!it.releaseDate || it.releaseDate <= today()); }),
          page: meta.current_page || params.page || 1,
          totalPages: meta.last_page || 1
        };
      });
    },
    // "New releases": page n of each home studio, merged newest first
    merged: function (key, page, year) {
      var self = this;
      return Promise.all(TPDB_SITES.slice(0, HOME_STUDIOS).map(function (s) {
        var params = { site_id: s.id, page: page, per_page: 6 };
        if (year) params.year = year;
        return self.movies(key, params).then(function (p) { return p; }, function () { return null; });
      })).then(function (pages) {
        pages = pages.filter(Boolean);
        if (!pages.length) {
          throw new Error('ThePornDB didn\'t answer');
        }
        var items = [].concat.apply([], pages.map(function (p) { return p.items; }));
        items.sort(function (a, b) { return (b.releaseDate || '').localeCompare(a.releaseDate || ''); });
        return { items: items, page: page, totalPages: Math.max.apply(null, pages.map(function (p) { return p.totalPages; })) };
      });
    },
    home: function () {
      return [{ row: 'latest', title: 'New releases' }].concat(TPDB_SITES.slice(0, HOME_STUDIOS).map(function (s) {
        return { row: 'studio:' + s.id, title: s.name };
      }));
    },
    discover: function (key, o) {
      var year = this.year(o.period);
      if (!o.studio) {
        return this.merged(key, o.page || 1, year);
      }
      var params = { site_id: o.studio, page: o.page || 1 };
      if (year) params.year = year;
      return this.movies(key, params);
    },
    row: function (key, row, page) {
      var studio = /^studio:(\d+)$/.exec(row);
      return studio ? this.movies(key, { site_id: studio[1], page: page }) : this.merged(key, page);
    },
    search: function (key, o) {
      var self = this, params = { q: o.q, page: o.page || 1, per_page: 30 }, year = this.year(o.period);
      if (year) params.year = year;
      return this.get(key, '/movies', params).then(function (data) {
        var meta = data.meta || {};
        return {
          items: (data.data || []).map(function (m) { return self.item(m); })
            .filter(function (it) { return it.poster && (!it.releaseDate || it.releaseDate <= today()); }),
          page: meta.current_page || params.page,
          totalPages: meta.last_page || 1
        };
      });
    },
    title: function (key, id) {
      var self = this;
      return this.get(key, '/movies/' + encodeURIComponent(id)).then(function (data) {
        var m = data.data || data, result = self.item(m), duration = Number(m.duration) || 0, director = (m.directors || [])[0];
        return Object.assign(result, {
          runtime: duration ? Math.round(duration / 60) : null,
          performers: (m.performers || []).map(function (p) {
            return { name: p.name || (p.parent && p.parent.name) || '', photo: self.pick(p, ['face', 'parent.face', 'image', 'parent.image']) };
          }).filter(function (p) { return p.name; }),
          director: director ? director.name : null,
          browsableStudio: result.studio && /^\d+$/.test(result.studio.id) ? result.studio.id : null
        });
      });
    }
  }
};

/**
 * The catalog this profile uses: its choice when its key is set, else the
 * other one that has a key; null when neither has: { id, provider, key }
 */
function catalogFor(ctx, wanted) {
  return Promise.all([
    wanted ? Promise.resolve(wanted) : playpex.settings.get('metadataProvider', ctx),
    playpex.secrets.get('tmdbApiKey'),
    playpex.secrets.get('theporndbApiKey')
  ]).then(function (r) {
    var keys = { tmdb: r[1], theporndb: r[2] },
      order = r[0] === 'theporndb' ? ['theporndb', 'tmdb'] : ['tmdb', 'theporndb'],
      id = wanted ? (keys[wanted] ? wanted : null) : order.filter(function (k) { return keys[k]; })[0];
    return id ? { id: id, provider: PROVIDERS[id], key: keys[id] } : null;
  });
}

var NO_KEY = 'The 18+ catalog needs a TMDB API key or a ThePornDB one: enter it in the 18+ plugin\'s settings on the server\'s dashboard.';

// ── cards and rows ──────────────────────────────────────────────────────────

function infoOf(it, details) {
  var meta = [];
  if (it.year) meta.push({ kind: 'text', text: String(it.year) });
  meta.push({ kind: 'seal', text: '18+' });
  if (details && details.runtime) meta.push({ kind: 'text', text: details.runtime + ' min' });
  if (it.rating) meta.push({ kind: 'score', source: 'provider', value: Math.min(10, it.rating) });
  var info = {
    title: clip(it.title, 200),
    meta: meta,
    overview: clip(it.overview, 4000),
    overviewFallback: 'No description.',
    backdrop: it.backdrop || null
  };
  if (it.studio && it.studio.name) info.eyebrow = clip(it.studio.name, 200);
  if (details) {
    var credits = [];
    if (details.performers.length) credits.push({ label: 'Starring', names: details.performers.slice(0, 20).map(function (p) { return clip(p.name, 80); }) });
    if (details.director) credits.push({ label: 'Director', names: [clip(details.director, 80)] });
    if (credits.length) info.credits = credits;
  }
  return info;
}

function cardOf(providerId, it) {
  return {
    key: 'adult:' + providerId + ':' + it.id,
    title: clip(it.title, 200),
    variant: 'poster',
    image: it.poster,
    subtitle: it.year ? String(it.year) : undefined,
    rating: it.rating ? { source: 'provider', value: Math.min(10, it.rating) } : null,
    intent: { screen: 'plugin.adult.title', params: { provider: providerId, id: it.id } },
    info: infoOf(it)
  };
}

function pagedRow(key, title, args) {
  return { key: 'adult:' + key, title: clip(title, 200), variant: 'poster', page: { data: 'rowPage', args: args } };
}

// ── the layout, per profile ─────────────────────────────────────────────────

function layoutKey(ctx) {
  return 'layout:' + (ctx && ctx.profile ? ctx.profile.id : 'none');
}

function viewGroup(current) {
  return { key: 'view', label: 'View', options: [
    { value: 'posters', label: 'Posters', on: current === 'posters' },
    { value: 'list', label: 'List', on: current === 'list' }
  ] };
}

/** The view the user just chose (a filter), kept; else the profile's last one */
function layoutOf(args, ctx, screen) {
  var chosen = args.filters && args.filters.view && args.filters.view[0];
  if (chosen === 'posters' || chosen === 'list') {
    return playpex.store.set(layoutKey(ctx), chosen).then(function () { return { layout: chosen, chosen: true }; });
  }
  return playpex.store.get(layoutKey(ctx)).then(function (v) {
    return { layout: v === 'list' || v === 'posters' ? v : screen, chosen: false };
  });
}

function switchTo(screen) {
  return [{ type: 'open', intent: { screen: 'plugin.adult.' + screen, replace: true } }];
}

// ── data handlers ───────────────────────────────────────────────────────────

// The poster layout: the provider's home rows; a studio / period → its sorts
// within them; a search → one row of results
playpex.data('browse', function (args, ctx) {
  args = args || {};
  return layoutOf(args, ctx, 'posters').then(function (l) {
    if (l.layout === 'list') {
      return { data: { rows: [] }, effects: switchTo('releases') };
    }
    return catalogFor(ctx).then(function (c) {
      if (!c) {
        return { data: { title: '18+', rows: [], search: false, filters: [viewGroup('posters')], empty: NO_KEY } };
      }
      var f = args.filters || {}, studio = (f.studio || [])[0] || null, period = (f.period || [])[0] || '',
        q = String(args.query || '').trim(), rows;
      if (q) {
        rows = [pagedRow('search', 'Results for “' + clip(q, 60) + '”', { provider: c.id, q: q, period: period })];
      } else if (studio || period) {
        var names = { popular: 'Popular', newest: 'Newest', rated: 'Top rated' };
        rows = c.provider.sorts.map(function (s) {
          return pagedRow('discover:' + s, names[s], { provider: c.id, sort: s, studio: studio, period: period });
        });
      } else {
        rows = c.provider.home().map(function (r) { return pagedRow('row:' + r.row, r.title, { provider: c.id, row: r.row }); });
      }
      return {
        data: {
          title: '18+',
          rows: rows,
          search: true,
          filters: [
            viewGroup('posters'),
            { key: 'studio', label: 'Studio', options: c.provider.studios.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
              .map(function (s) { return { value: s.id, label: clip(s.name, 40), on: s.id === studio }; }) },
            { key: 'period', label: 'Released', options: c.provider.periods.filter(function (p) { return p[0]; })
              .map(function (p) { return { value: p[0], label: p[1], on: p[0] === period }; }) }
          ],
          empty: q ? 'Nothing found for “' + clip(q, 60) + '”.' : 'Nothing to show.'
        }
      };
    });
  });
});

playpex.data('rowPage', function (args, ctx) {
  args = args || {};
  var page = Math.max(1, args.page || 1);
  return catalogFor(ctx, args.provider).then(function (c) {
    if (!c) {
      return { data: { items: [], last: true } };
    }
    var read = args.q ? c.provider.search(c.key, { q: args.q, period: args.period, page: page }) :
      args.row ? c.provider.row(c.key, args.row, page) :
        c.provider.discover(c.key, { studio: args.studio, period: args.period, sort: args.sort, page: page });
    return read.then(function (p) {
      return { data: { items: p.items.slice(0, 100).map(function (it) { return cardOf(c.id, it); }), last: p.page >= p.totalPages || !p.items.length } };
    });
  });
});

// One title: details, Play, Find releases, performers (→ releases searched
// for them), More from its studio
playpex.data('title', function (args, ctx) {
  var params = (args && args.params) || {};
  return catalogFor(ctx, params.provider).then(function (c) {
    if (!c) {
      return { data: { info: { title: '18+', notes: [NO_KEY] } } };
    }
    return c.provider.title(c.key, params.id).then(function (t) {
      var rows = [];
      if (t.performers.length) {
        rows.push({ key: 'adult:cast', title: 'Starring', variant: 'portrait', items: t.performers.slice(0, 30).map(function (p, i) {
          return { key: 'adult:performer:' + i, title: clip(p.name, 200), variant: 'portrait', image: p.photo || null,
            intent: { screen: 'plugin.adult.find', params: { q: clip(p.name, 60) } } };
        }) });
      }
      if (t.browsableStudio && t.studio) {
        rows.push(pagedRow('more', 'More from ' + t.studio.name, { provider: c.id, row: 'studio:' + t.browsableStudio }));
      }
      return {
        data: {
          info: infoOf(t, t),
          actions: [
            { key: 'adult:play', label: 'Play', icon: 'play', call: { data: 'play', args: { provider: c.id, id: t.id } } },
            { key: 'adult:releases', label: 'Find releases', icon: 'search', intent: { screen: 'plugin.adult.find', params: { q: clip(t.title, 60) } } }
          ],
          rows: rows
        }
      };
    });
  });
});

// Play: the film's torrents, best first, in the core's source picker; nothing is saved
playpex.data('play', function (args, ctx) {
  args = args || {};
  return catalogFor(ctx, args.provider).then(function (c) {
    if (!c) {
      return { data: null, effects: [{ type: 'toast', text: 'Enter a catalog key in the 18+ plugin\'s settings', tone: 'error' }] };
    }
    return c.provider.title(c.key, args.id).then(function (t) {
      return findTorrents(t.title, t.year).then(function (found) {
        if (!found.torrents.length) {
          return { data: null, effects: [{ type: 'toast', tone: found.failed ? 'error' : 'info',
            text: found.failed ? 'The torrent sites didn\'t answer' : 'No torrents found for this title' }] };
        }
        return {
          data: null,
          effects: [{ type: 'play', request: {
            title: clip(t.title, 200),
            subtitle: t.studio ? clip(t.studio.name, 200) : undefined,
            artwork: Object.assign({}, t.poster ? { poster: t.poster } : {}, t.backdrop ? { backdrop: t.backdrop } : {}),
            tracking: 'none',
            sources: found.torrents.slice(0, 50).map(function (x) {
              return { kind: 'magnet', magnet: magnetOf(x.hash, x.name), label: clip(x.name, 200), quality: x.quality,
                size: x.size, seeds: x.seeds, codec: x.codec, audio: x.audio, notes: notesOf(x).slice(0, 6) };
            })
          } }]
        };
      });
    });
  });
});

var QUALITY_LABELS = [['2160p', '4K'], ['1080p', '1080p'], ['720p', '720p'], ['SD', 'SD']];

// The list layout (and Find releases: screen `find`, its params.q): one
// source's releases, most seeded first; a filtered page reads on (up to 3)
// until 20 are kept
playpex.data('releases', function (args, ctx) {
  args = args || {};
  var params = args.params || {}, f = args.filters || {}, page = Math.max(1, args.page || 1),
    section = !params.q;
  var go = section ? layoutOf(args, ctx, 'list') : Promise.resolve({ layout: 'list' });
  return go.then(function (l) {
    if (l.layout === 'posters') {
      return { data: { releases: [], last: true }, effects: switchTo('browse') };
    }
    var source = SOURCES.filter(function (s) { return s.id === (f.source || [])[0]; })[0] || SOURCES[0],
      quality = (f.quality || [])[0] || '',
      playableOnly = (f.plays || [])[0] === 'yes',
      q = String(args.query || params.q || '').trim(),
      filters = (section ? [viewGroup('list')] : []).concat([
        { key: 'source', label: 'Source', options: SOURCES.map(function (s) { return { value: s.id, label: s.name, on: s === source }; }) },
        { key: 'quality', label: 'Quality', options: QUALITY_LABELS.map(function (x) { return { value: x[0], label: x[1], on: x[0] === quality }; }) },
        { key: 'plays', label: 'Plays here', options: [{ value: 'yes', label: 'Only those that play', on: playableOnly }] }
      ]);
    if (page > 1 && !source.paged) {
      return { data: { releases: [], last: true, filters: filters } };
    }
    var seen = {};
    function keep(t) {
      if (seen[t.hash]) return false;
      seen[t.hash] = true;
      return (!quality || t.quality === quality || (quality === 'SD' && t.quality === '480p')) &&
        (!playableOnly || (t.playable && t.audio !== 'unsupported'));
    }
    function read(from, kept, reads) {
      return source.list({ q: q, quality: quality, page: from }).then(function (r) {
        var list = kept.concat(r.results.map(function (t) { return Object.assign(t, describe(t.name)); }).filter(keep));
        if (source.paged && r.hasMore && list.length < 20 && reads + 1 < 3) {
          return read(from + 1, list, reads + 1);
        }
        return { list: list, more: source.paged && r.hasMore };
      });
    }
    return read(page, [], 0).then(function (r) {
      r.list.sort(function (a, b) { return b.seeds - a.seeds; });
      return {
        data: {
          title: q ? 'Releases of “' + clip(q, 60) + '”' : '18+',
          releases: r.list.slice(0, 200).map(function (t) {
            var out = { title: clip(present(t.name).title, 300), magnet: magnetOf(t.hash, t.name), seeds: t.seeds, size: t.size,
              notes: notesOf(t).concat([clip(t.name, 80)]).slice(-6) };
            if (t.peers != null) out.peers = t.peers;
            if (t.quality) out.quality = t.quality;
            if (t.added) out.uploadedAt = new Date(t.added * 1000).toISOString();
            return out;
          }),
          // the core asks for page + 1 next; a filtered page may have read several
          last: !r.more,
          filters: filters,
          empty: q ? 'No releases found for “' + clip(q, 60) + '”.' : 'No releases.'
        }
      };
    });
  });
});

// The search page's "18+" chip: the catalog's search for the query
playpex.data('searchFilter', function (args, ctx) {
  var q = String((args && args.context && args.context.query) || '').trim();
  var chip = { key: 'adult:18', label: '18+' };
  return catalogFor(ctx).then(function (c) {
    if (!c || q.length < 3) {
      return { data: { chip: chip, rows: [] } };
    }
    return c.provider.search(c.key, { q: q, page: 1 }).then(function (p) {
      return { data: { chip: chip, rows: p.items.length ? [{
        key: 'adult:search-results', title: 'Adult movies', variant: 'poster',
        items: p.items.slice(0, 100).map(function (it) { return cardOf(c.id, it); })
      }] : [] } };
    });
  });
});

// tests (Node, not the sandbox): the pure parts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { present: present, describe: describe, match: match, compare: compare, notesOf: notesOf };
}
