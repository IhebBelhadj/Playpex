'use strict';

// Finds torrents for one 18+ movie (TMDB `adult: true`; YTS has none) across
// TheRARBG's XXX category and The Pirate Bay's porn category, and ranks them
// like episodes.js does. These titles rarely have an IMDb id, so matching is by
// title (+ year) in the release name.

var therarbg = require('./providers/therarbg');
var piratebay = require('./providers/piratebay');
var trackers = require('./trackers');
var episodes = require('./episodes');

var describe = episodes.describe,
  normalizeTitle = episodes.normalizeTitle;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// null when the release isn't this movie, else { yearMatch }.
// The name has to start with the title (after a leading "[Studio]" tag), as
// whole words not followed by a sequel number ("Insatiable Cuties" isn't
// "Insatiable Cuties 2"); titles found mid-name are scenes of other productions
// ("BrazzersExxtra 20.07.22 Portia Paris The Naked Wife"). A release stating
// another year is another film.
function match(name, title, year) {
  var normalized = normalizeTitle(String(name).replace(/^\s*(\[[^\]]*\]|\([^)]*\)|\s)+/, ''));
  var wanted = normalizeTitle(title);
  if (!wanted) {
    return null;
  }

  var found = new RegExp('^' + escapeRegExp(wanted).replace(/ /g, ' +') + '(?= |$)(?! +([2-9]|[1-9]\\d)( |$))')
    .test(normalized);
  if (!found) {
    return null;
  }

  var yearMatch = false;
  // years after the title (its own words may hold one: "Summer 2049")
  var years = normalized.slice(wanted.length).match(/\b(19|20)\d\d\b/g) || [];
  if (year && years.length) {
    yearMatch = years.some(function (y) {
      return Math.abs(Number(y) - year) <= 1;
    });
    if (!yearMatch) {
      return null;
    }
  }
  return { yearMatch: yearMatch };
}

function compare(a, b) {
  return (b.playable - a.playable) ||
    (episodes.AUDIO_RANK[b.audio] - episodes.AUDIO_RANK[a.audio]) ||
    ((b.seeds >= episodes.HEALTHY_SEEDS) - (a.seeds >= episodes.HEALTHY_SEEDS)) ||
    (a.scenes - b.scenes) ||
    (b.yearMatch - a.yearMatch) ||
    ((episodes.RESOLUTION_RANK[b.quality] || 0) - (episodes.RESOLUTION_RANK[a.quality] || 0)) ||
    (b.seeds - a.seeds);
}

// title: the movie's title (original or translated, as TMDB names it); year: release year or NaN
function findAdultTorrents(title, year) {
  var searches = [therarbg.searchAdult(title), piratebay.searchAdult(title)];

  return Promise.allSettled(searches).then(function (results) {
    var byHash = {};
    var errors = [];

    results.forEach(function (result) {
      if (result.status === 'rejected') {
        errors.push(result.reason && result.reason.message);
        return;
      }
      result.value.forEach(function (torrent) {
        var found = match(torrent.name, title, year);
        if (!found) {
          return;
        }
        var existing = byHash[torrent.hash];
        var magnets = existing ? [existing.magnet, torrent.magnet] : [torrent.magnet];
        if (!existing || torrent.seeds > existing.seeds) {
          byHash[torrent.hash] = Object.assign(torrent, describe(torrent.name), found, {
            pack: false,
            // one file per scene, not the whole film: the player plays one of them
            scenes: /\bsplit.?scenes?\b/i.test(torrent.name)
          });
        }
        var kept = byHash[torrent.hash];
        kept.magnet = trackers.build(kept.hash, kept.name, magnets);
      });
    });

    if (errors.length) {
      console.log('adult search errors: ' + errors.join('; '));
    }

    var torrents = Object.keys(byHash).map(function (hash) {
      return byHash[hash];
    });
    torrents.sort(compare);

    return { torrents: torrents, providerErrors: errors.length };
  });
}

// ── the 18+ section: browse a provider, most seeded first ──────────────────

// id → how to list it. The first one is the default.
// quality: '' | '2160p' | '1080p' | '720p' | 'SD'
var BROWSE_PROVIDERS = [
  {
    id: 'piratebay',
    name: 'The Pirate Bay',
    paged: false,
    list: function (q, quality) {
      // its own subcategories narrow the top-100 lists by resolution
      var category = quality === '2160p' ? '507' : (quality === '1080p' || quality === '720p') ? '505' : '500';
      return piratebay.browseAdult(q, category);
    }
  },
  {
    id: 'therarbg',
    name: 'TheRARBG',
    paged: true,
    // (a resolution in the keywords would rank by name, not by seeders)
    list: function (q, quality, page) {
      return therarbg.browseAdult(q, page);
    }
  }
];

var QUALITIES = ['2160p', '1080p', '720p', 'SD'];

// A filtered page of a paged provider can come out nearly empty: read on until
// MIN_RESULTS are kept or MAX_PAGES_PER_CALL pages are read
var MIN_RESULTS = 20;
var MAX_PAGES_PER_CALL = 3;

// Release name → what the list shows. "Heatwave Vol. 2 [Vixen 2026] XXX WEB-DL
// 1080p SPLIT SCENES MP4-P2P [XC]" → title "Heatwave Vol. 2", studio "Vixen",
// year 2026. Scene names keep their date: "Vixen 26 08 20 Gal Ritchie …".
var JUNK = /\b(xxx|2160p|1080p|720p|480p|4k|uhd|web.?dl|webrip|hdrip|bluray|dvdrip|split.?scenes?|mp4|mkv|wmv|x26[45]|h\.?26[45]|hevc|p2p|[-.](xc|trb|ktr|gush|wrb|nbq|xleech))\b/i;

function present(name) {
  var text = String(name)
    .replace(/\.(mp4|mkv|avi|wmv)$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
  if (title.length < 3) {
    title = text;
  }
  return { title: title, studio: studio, year: year };
}

// { provider, q, quality, playable, page } → { provider, page, hasMore, torrents }
function browse(options) {
  var provider = BROWSE_PROVIDERS.filter(function (p) {
    return p.id === options.provider;
  })[0] || BROWSE_PROVIDERS[0];
  var quality = QUALITIES.indexOf(options.quality) !== -1 ? options.quality : '';
  var page = Math.max(1, options.page || 1);

  if (page > 1 && !provider.paged) {
    return Promise.resolve({ provider: provider.id, page: page, hasMore: false, torrents: [] });
  }

  var q = String(options.q || '').trim();

  function keep(torrent) {
    return (!quality || torrent.quality === quality ||
        (quality === 'SD' && torrent.quality === '480p')) &&
      (!options.playable || (torrent.playable && torrent.audio !== 'unsupported'));
  }

  function read(from, kept, reads) {
    return provider.list(q, quality, from).then(function (list) {
      var torrents = kept.concat(list.results
        .map(function (torrent) {
          return Object.assign(torrent, describe(torrent.name), present(torrent.name), {
            scenes: /\bsplit.?scenes?\b/i.test(torrent.name)
          });
        })
        .filter(keep));

      if (provider.paged && list.hasMore && torrents.length < MIN_RESULTS && reads + 1 < MAX_PAGES_PER_CALL) {
        return read(from + 1, torrents, reads + 1);
      }
      return { lastPage: from, hasMore: list.hasMore, torrents: torrents };
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

function browseProviders() {
  return BROWSE_PROVIDERS.map(function (p, i) {
    return { id: p.id, name: p.name, paged: p.paged, default: i === 0 };
  });
}

module.exports = {
  findAdultTorrents: findAdultTorrents,
  match: match,
  browse: browse,
  browseProviders: browseProviders,
  present: present
};
