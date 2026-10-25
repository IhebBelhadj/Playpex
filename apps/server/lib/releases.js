'use strict';

// "Find releases" lists: one source's releases for a kind of media, most
// seeded first, with a quality filter, a "playable" filter, keywords and
// paging. Kinds: 'movie', 'tv'. Routes: /api/releases/{providers,browse}.
// The sources are plugins with `releases.providers` (`plugin:<id>`; hook kinds
// `movie` / `show`), never `audience: adults` ones (no profile here): the core
// reads no torrent site (docs/providers-plan.md §4). No such plugin → no
// source, and browse answers an empty list.
// Keywords reach the sources as plain words (names.searchWords: "Breaking.Bad"
// → "Breaking Bad"), and each torrent says whether its name holds every one
// of them (`matches`, names.searchMatches): sites answer loosely. Shows'
// keywords without an IMDb id get the show's from the catalog when a show is
// titled exactly so (showImdb): sources like EZTV list a show by its id, not
// by words.

var names = require('./media/names');
var trackers = require('./trackers');

var describe = names.describe;

var QUALITIES = ['2160p', '1080p', '720p', 'SD'];

// A filtered page can come out nearly empty: read on until MIN_RESULTS are
// kept or MAX_PAGES_PER_CALL pages are read
var MIN_RESULTS = 20;
var MAX_PAGES_PER_CALL = 3;

var KINDS = ['movie', 'tv'];

function isKind(kind) {
  return KINDS.indexOf(kind) !== -1;
}

var HOOK_KINDS = { movie: 'movie', tv: 'show' },
  // what withHook filters on: as a kids profile would, so no adults plugin
  NO_ADULTS = { profile: { id: '', kids: true }, device: null, locale: 'en' };

// A plugin's release as a provider's torrent (the server's trackers, not its own)
function fromPlugin(pluginId, r) {
  var hash = (r.infoHash || (/xt=urn:btih:([0-9a-fA-F]{40})/.exec(r.magnet || '') || [])[1] || '').toLowerCase();
  if (!hash) {
    return null;
  }
  return {
    provider: pluginId,
    name: r.title,
    hash: hash,
    magnet: trackers.build(hash, r.title),
    seeds: r.seeds,
    peers: r.peers === undefined ? null : r.peers,
    size: r.size || null,
    added: r.uploadedAt ? Math.floor(Date.parse(r.uploadedAt) / 1000) || 0 : 0
  };
}

function pluginProviders(kind) {
  var plugins = require('./plugins');
  if (!HOOK_KINDS[kind]) {
    return [];
  }
  return plugins.withHook('releases.providers', NO_ADULTS).filter(function (p) {
    // contributes.releases.kinds: the kinds it lists (default both)
    var loaded = plugins.get(p.id),
      kinds = loaded && loaded.manifest.contributes && loaded.manifest.contributes.releases && loaded.manifest.contributes.releases.kinds;
    return !kinds || kinds.indexOf(HOOK_KINDS[kind]) !== -1;
  }).map(function (p) {
    return {
      id: 'plugin:' + p.id,
      name: p.name,
      paged: true,
      list: function (c) {
        var input = { kind: HOOK_KINDS[kind], page: c.page };
        if (c.q) {
          input.query = c.q;
        }
        if (c.quality) {
          input.filters = { quality: c.quality };
        }
        // the title the list is about (a site may list one show's torrents)
        if (c.imdb) {
          input.title = { kind: HOOK_KINDS[kind], imdbId: 'tt' + c.imdb.replace(/^tt/, '') };
        }
        return plugins.runHook('releases.providers', input, NO_ADULTS, { only: p.id }).then(function (r) {
          if (!r.results.length) {
            throw new Error(p.name + ': ' + (r.errors[0] ? r.errors[0].message : 'no answer'));
          }
          var out = r.results[0].output;
          return {
            results: out.releases.map(function (rel) { return fromPlugin(p.id, rel); }).filter(Boolean),
            hasMore: !out.last
          };
        });
      }
    };
  });
}

function all(kind) {
  return pluginProviders(kind);
}

function providers(kind) {
  if (!isKind(kind)) {
    throw new Error('unknown kind: ' + kind);
  }
  return all(kind).map(function (p, i) {
    return { id: p.id, name: p.name, paged: p.paged, default: i === 0 };
  });
}

// release → what the list shows (fields the provider set itself, title/year,
// win over the parsed ones)
function decorate(kind, torrent, q) {
  var presented = names.release(torrent.name, kind);
  var own = {};
  ['title', 'year'].forEach(function (key) {
    if (torrent[key] !== undefined && torrent[key] !== null && torrent[key] !== '') {
      own[key] = torrent[key];
    }
  });
  return Object.assign(torrent, describe(torrent.name), presented, own, { matches: names.searchMatches(torrent.name, q) });
}

// "breaking bad s01e05 1080p" → the IMDb id of the show titled "Breaking Bad"
// (TMDB behind lib/catalog), or null; remembered a while, at most 200 names
var SHOW_IDS = new Map(), SHOW_IDS_MAX = 200, SHOW_IDS_TTL = 6 * 3600 * 1000;

function showImdb(q) {
  var name = names.parse(q).title || q, key = names.normalizeTitle(name), now = Date.now();
  if (!key) {
    return Promise.resolve(null);
  }
  var known = SHOW_IDS.get(key);
  if (known && known.until > now) {
    return known.id;
  }
  var catalog = require('./catalog');
  var id = Promise.resolve().then(function () {
    return catalog.search('tv', { q: name });
  }).then(function (found) {
    var show = (found.results || []).filter(function (r) {
      return r.mediaType === 'tv' && (names.normalizeTitle(r.title) === key || names.normalizeTitle(r.originalTitle || '') === key);
    })[0];
    return show ? catalog.details('tv', show.tmdbId).then(function (d) { return d.imdbId || null; }) : null;
  }).catch(function () {
    // no catalog (offline, no key): words alone, and asked again next time
    SHOW_IDS.delete(key);
    return null;
  });
  if (SHOW_IDS.size >= SHOW_IDS_MAX) {
    SHOW_IDS.delete(SHOW_IDS.keys().next().value);
  }
  SHOW_IDS.set(key, { id: id, until: now + SHOW_IDS_TTL });
  return id;
}

// options: { kind, provider, q, quality, playable, page, imdb }
// → { provider, page, hasMore, torrents }
function browse(options) {
  var kind = options.kind || 'movie';
  if (!isKind(kind)) {
    return Promise.reject(new Error('unknown kind: ' + kind));
  }
  var list = all(kind);
  var provider = list.filter(function (p) {
    return p.id === options.provider;
  })[0] || list[0];
  if (!provider) {
    return Promise.resolve({ provider: null, page: 1, hasMore: false, torrents: [] });
  }
  var quality = QUALITIES.indexOf(options.quality) !== -1 ? options.quality : '';
  var page = Math.max(1, options.page || 1);

  if (page > 1 && !provider.paged) {
    return Promise.resolve({ provider: provider.id, page: page, hasMore: false, torrents: [] });
  }

  var q = names.searchWords(options.q);
  var imdb = /^(tt)?\d{5,10}$/.test(String(options.imdb || '')) ? String(options.imdb) : null;
  var seen = {};

  function keep(torrent) {
    if (seen[torrent.hash]) {
      return false;
    }
    seen[torrent.hash] = true;
    return (!quality || torrent.quality === quality ||
        (quality === 'SD' && torrent.quality === '480p')) &&
      (!options.playable || (torrent.playable && torrent.audio !== 'unsupported'));
  }

  function read(from, kept, reads) {
    return provider.list({ q: q, quality: quality, page: from, imdb: imdb }).then(function (result) {
      var torrents = kept.concat(result.results
        .map(function (torrent) {
          return decorate(kind, torrent, q);
        })
        .filter(keep));

      if (provider.paged && result.hasMore && torrents.length < MIN_RESULTS && reads + 1 < MAX_PAGES_PER_CALL) {
        return read(from + 1, torrents, reads + 1);
      }
      return { lastPage: from, hasMore: result.hasMore, torrents: torrents };
    });
  }

  var context = imdb || kind !== 'tv' || !q ? Promise.resolve(imdb) : showImdb(q);

  return context.then(function (id) {
    imdb = id;
    return read(page, [], 0);
  }).then(function (result) {
    result.torrents.sort(function (a, b) {
      return b.seeds - a.seeds;
    });
    // `page`: the last page read; ask for page + 1 next
    return { provider: provider.id, page: result.lastPage, hasMore: result.hasMore, torrents: result.torrents };
  });
}

module.exports = {
  KINDS: KINDS,
  isKind: isKind,
  providers: providers,
  browse: browse
};
