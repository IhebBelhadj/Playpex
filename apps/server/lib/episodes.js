'use strict';

// Finds torrents for one TV episode across all providers and ranks them for
// streaming in Electron's Chromium (lib/media/names.js: matching, playability,
// ranking).

var eztv = require('./providers/eztv');
var therarbg = require('./providers/therarbg');
var trackers = require('./trackers');
var names = require('./media/names');
var log = require('./logger').child('provider');

// imdbId: "tt0944947" or "0944947"; title: show name (used by text-search providers)
function findEpisodeTorrents(imdbId, title, season, episode) {
  var searches = [];
  if (imdbId) {
    searches.push(eztv.search(String(imdbId).replace(/^tt/, ''), season, episode));
  }
  if (title) {
    searches.push(therarbg.search(title, season, episode));
  }

  return Promise.allSettled(searches).then(function (results) {
    var byHash = {};
    var errors = [];

    results.forEach(function (result) {
      if (result.status === 'rejected') {
        errors.push(result.reason && result.reason.message);
        return;
      }
      result.value.forEach(function (torrent) {
        var kind = names.matchKind(torrent.name, title, season, episode);
        if (!kind) {
          return;
        }
        var existing = byHash[torrent.hash];
        // Same torrent from several providers: keep the best seed count, but
        // announce to every tracker any of them listed
        var magnets = existing ? [existing.magnet, torrent.magnet] : [torrent.magnet];
        if (!existing || torrent.seeds > existing.seeds) {
          // Packs hold the whole season; the player streams only this episode's file
          byHash[torrent.hash] = Object.assign(torrent, names.describe(torrent.name), { pack: kind === 'pack' });
        }
        var kept = byHash[torrent.hash];
        kept.magnet = trackers.build(kept.hash, kept.name, magnets);
      });
    });

    if (errors.length) {
      log.warn('episode search errors: ' + errors.join('; '));
    }

    var torrents = Object.keys(byHash).map(function (hash) {
      return byHash[hash];
    });
    torrents.sort(names.compare);

    return { torrents: torrents, providerErrors: errors.length };
  });
}

module.exports = {
  findEpisodeTorrents: findEpisodeTorrents
};
