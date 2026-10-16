'use strict';

// "Find releases" lists: one torrent source's releases for a kind of media,
// most seeded first, with a quality filter, a "playable" filter, keywords and
// paging for paged sources. Kinds: 'adult' (the 18+ section), 'movie', 'tv'.
// Routes: /api/releases/{providers,browse} (and /api/adult/{providers,browse}
// = kind 'adult', see adult.js).

var piratebay = require('./providers/piratebay');
var therarbg = require('./providers/therarbg');
var eztv = require('./providers/eztv');
var yts = require('./providers/yts');
var episodes = require('./episodes');
var present = require('./present');

var describe = episodes.describe;

var QUALITIES = ['2160p', '1080p', '720p', 'SD'];

// A filtered page of a paged provider can come out nearly empty: read on until
// MIN_RESULTS are kept or MAX_PAGES_PER_CALL pages are read
var MIN_RESULTS = 20;
var MAX_PAGES_PER_CALL = 3;

// The Pirate Bay subcategories. Top-100 lists by quality filter; keywords search
// the parent category and keep the subcategories of the kind.
function pirateBayLists(all, sd, hd, uhd) {
  return function (quality) {
    return quality === '2160p' ? [uhd] : (quality === '1080p' || quality === '720p') ? [hd] :
      quality === 'SD' ? [sd] : all;
  };
}

var movieLists = pirateBayLists(['201', '207', '211'], '201', '207', '211');
var tvLists = pirateBayLists(['205', '208', '212'], '205', '208', '212');

// kind → its sources; the first one is the default.
// list(context) → Promise<{ results: [release], hasMore }>
// context: { q, quality ('' or one of QUALITIES), page, imdb }
var PROVIDERS = {
  adult: [
    {
      id: 'piratebay',
      name: 'The Pirate Bay',
      paged: false,
      list: function (c) {
        // its own subcategories narrow the top-100 lists by resolution
        var category = c.quality === '2160p' ? '507' : (c.quality === '1080p' || c.quality === '720p') ? '505' : '500';
        return piratebay.browseAdult(c.q, category);
      }
    },
    {
      id: 'therarbg',
      name: 'TheRARBG',
      paged: true,
      // (a resolution in the keywords would rank by name, not by seeders)
      list: function (c) {
        return therarbg.browseAdult(c.q, c.page);
      }
    }
  ],
  movie: [
    {
      id: 'piratebay',
      name: 'The Pirate Bay',
      paged: false,
      // 201 Movies, 207 HD - Movies, 211 UHD/4k - Movies (not 202 DVDR images, 209 3D)
      list: function (c) {
        return piratebay.browse(c.q, { lists: movieLists(c.quality), searchCategory: '200', categories: ['201', '207', '211'] });
      }
    },
    {
      id: 'therarbg',
      name: 'TheRARBG',
      paged: true,
      list: function (c) {
        return therarbg.browse(c.q, 'Movies', c.page);
      }
    },
    {
      id: 'yts',
      name: 'YTS',
      paged: true,
      list: function (c) {
        return yts.browse(c.q, c.quality, c.page);
      }
    }
  ],
  tv: [
    {
      id: 'piratebay',
      name: 'The Pirate Bay',
      paged: false,
      // 205 TV shows, 208 HD - TV shows, 212 UHD/4k - TV shows
      list: function (c) {
        return piratebay.browse(c.q, { lists: tvLists(c.quality), searchCategory: '200', categories: ['205', '208', '212'] });
      }
    },
    {
      id: 'therarbg',
      name: 'TheRARBG',
      paged: true,
      list: function (c) {
        return therarbg.browse(c.q, 'TV', c.page);
      }
    },
    {
      id: 'eztv',
      name: 'EZTV',
      paged: true,
      // with an IMDb id: that show's torrents (keywords filter them); else the latest uploads
      list: function (c) {
        return eztv.browse(c.q, c.imdb, c.page);
      }
    }
  ]
};

function isKind(kind) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, kind);
}

function providers(kind) {
  if (!isKind(kind)) {
    throw new Error('unknown kind: ' + kind);
  }
  return PROVIDERS[kind].map(function (p, i) {
    return { id: p.id, name: p.name, paged: p.paged, default: i === 0 };
  });
}

// release → what the list shows (fields the provider set itself, like YTS's
// title/year, win over the parsed ones)
function decorate(kind, torrent) {
  var presented = kind === 'adult' ? present.adult(torrent.name) : present.release(torrent.name, kind);
  var own = {};
  ['title', 'year', 'studio'].forEach(function (key) {
    if (torrent[key] !== undefined && torrent[key] !== null && torrent[key] !== '') {
      own[key] = torrent[key];
    }
  });
  return Object.assign(torrent, describe(torrent.name), presented, own, {
    // one file per scene, not the whole film (18+ only)
    scenes: kind === 'adult' && /\bsplit.?scenes?\b/i.test(torrent.name)
  });
}

// options: { kind, provider, q, quality, playable, page, imdb }
// → { provider, page, hasMore, torrents }
function browse(options) {
  var kind = options.kind || 'adult';
  if (!isKind(kind)) {
    return Promise.reject(new Error('unknown kind: ' + kind));
  }
  var list = PROVIDERS[kind];
  var provider = list.filter(function (p) {
    return p.id === options.provider;
  })[0] || list[0];
  var quality = QUALITIES.indexOf(options.quality) !== -1 ? options.quality : '';
  var page = Math.max(1, options.page || 1);

  if (page > 1 && !provider.paged) {
    return Promise.resolve({ provider: provider.id, page: page, hasMore: false, torrents: [] });
  }

  var q = String(options.q || '').trim();
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
          return decorate(kind, torrent);
        })
        .filter(keep));

      if (provider.paged && result.hasMore && torrents.length < MIN_RESULTS && reads + 1 < MAX_PAGES_PER_CALL) {
        return read(from + 1, torrents, reads + 1);
      }
      return { lastPage: from, hasMore: result.hasMore, torrents: torrents };
    });
  }

  return read(page, [], 0).then(function (result) {
    result.torrents.sort(function (a, b) {
      return b.seeds - a.seeds;
    });
    // `page`: the last page read; ask for page + 1 next
    return { provider: provider.id, page: result.lastPage, hasMore: result.hasMore, torrents: result.torrents };
  });
}

module.exports = {
  KINDS: Object.keys(PROVIDERS),
  isKind: isKind,
  providers: providers,
  browse: browse
};
