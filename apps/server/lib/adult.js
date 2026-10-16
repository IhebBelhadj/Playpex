'use strict';

// Finds torrents for one 18+ movie (TMDB `adult: true`; YTS has none) across
// TheRARBG's XXX category and The Pirate Bay's porn category, and ranks them
// like episodes.js does. These titles rarely have an IMDb id, so matching is by
// title (+ year) in the release name.

var therarbg = require('./providers/therarbg');
var piratebay = require('./providers/piratebay');
var trackers = require('./trackers');
var episodes = require('./episodes');
var releases = require('./releases');
var present = require('./present');
var log = require('./logger').child('provider');

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
      log.warn('adult search errors: ' + errors.join('; '));
    }

    var torrents = Object.keys(byHash).map(function (hash) {
      return byHash[hash];
    });
    torrents.sort(compare);

    return { torrents: torrents, providerErrors: errors.length };
  });
}

// ── the 18+ section: browse a provider, most seeded first ──────────────────
// The generic release list (lib/releases.js) with kind 'adult'.

// { provider, q, quality, playable, page } → { provider, page, hasMore, torrents }
function browse(options) {
  return releases.browse(Object.assign({}, options, { kind: 'adult' }));
}

function browseProviders() {
  return releases.providers('adult');
}

module.exports = {
  findAdultTorrents: findAdultTorrents,
  match: match,
  browse: browse,
  browseProviders: browseProviders,
  // release name → { title, studio, year } (lib/present.js)
  present: present.adult
};
