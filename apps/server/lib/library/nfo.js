'use strict';

// Kodi / Jellyfin / Plex .nfo files (docs/media-server-plan.md §5.2): the
// ids they carry, so a file named anything still matches. Read as text, no
// XML parser: <uniqueid type="tmdb|imdb">, <tmdbid>, <imdbid>, <id>, or a
// bare TMDB / IMDb URL (the "URL only" nfo).
//
//   read(paths) → { tmdbId, imdbId, showTmdbId, showImdbId, season, episode }

var fs = require('fs');

var MAX_BYTES = 512 * 1024;

function one(text, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i]);
    if (m) {
      return m[1];
    }
  }
  return null;
}

function ids(text) {
  var tmdb = one(text, [/<uniqueid[^>]*type=["']tmdb["'][^>]*>\s*(\d+)\s*</i, /<tmdbid>\s*(\d+)\s*</i,
      /themoviedb\.org\/(?:movie|tv)\/(\d+)/i]),
    imdb = one(text, [/<uniqueid[^>]*type=["']imdb["'][^>]*>\s*(tt\d{5,10})\s*</i, /<imdbid>\s*(tt\d{5,10})\s*</i,
      /<id>\s*(tt\d{5,10})\s*</i, /imdb\.com\/title\/(tt\d{5,10})/i, /\b(tt\d{7,10})\b/]);
  return { tmdbId: tmdb ? parseInt(tmdb, 10) : null, imdbId: imdb };
}

function number(text, tag) {
  var m = text.match(new RegExp('<' + tag + '>\\s*(\\d{1,4})\\s*</' + tag + '>', 'i'));
  return m ? parseInt(m[1], 10) : null;
}

function readText(file) {
  return fs.promises.stat(file).then(function (st) {
    return st.size > MAX_BYTES ? '' : fs.promises.readFile(file, 'utf8');
  }).catch(function () { return ''; });
}

/**
 * @param {string[]} files  full paths, nearest first (the walk's `nfo`)
 */
function read(files) {
  var found = { tmdbId: null, imdbId: null, showTmdbId: null, showImdbId: null, season: null, episode: null };
  return Promise.all(files.map(readText)).then(function (texts) {
    texts.forEach(function (text, i) {
      if (!text) {
        return;
      }
      var got = ids(text);
      if (/tvshow\.nfo$/i.test(files[i]) || /<tvshow[\s>]/i.test(text)) {
        found.showTmdbId = found.showTmdbId || got.tmdbId;
        found.showImdbId = found.showImdbId || got.imdbId;
      } else if (/<episodedetails[\s>]/i.test(text)) {
        // an episode's own ids are not its show's: only its numbers count
        found.season = found.season === null ? number(text, 'season') : found.season;
        found.episode = found.episode === null ? number(text, 'episode') : found.episode;
      } else {
        found.tmdbId = found.tmdbId || got.tmdbId;
        found.imdbId = found.imdbId || got.imdbId;
      }
    });
    return found;
  });
}

module.exports = {
  read: read,
  ids: ids
};
