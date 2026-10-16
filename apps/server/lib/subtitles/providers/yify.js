'use strict';

// YIFY Subtitles (yts-subs.com): movies only, no API key, HTML pages.
// Each subtitle page has a base64 `data-link` pointing at a .zip with the SRT.

var axios = require('axios').default;
var yauzl = require('yauzl');

var BASE = 'https://yts-subs.com';
var HEADERS = { 'User-Agent': 'Mozilla/5.0 (Playpex)' };

function decodeEntities(text) {
  return text.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

function search(query) {
  if (query.season) {
    return Promise.resolve([]);
  }
  return axios.get(BASE + '/movie-imdb/' + query.imdbId, { headers: HEADERS, timeout: 15000 })
    .then(function (res) {
      var rows = String(res.data).match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
      var seen = {};
      return rows.map(function (row) {
        var link = (row.match(/href="(\/subtitles\/[\w-]+)"/) || [])[1];
        var language = (row.match(/class="sub-lang">([^<]+)</) || [])[1];
        var title = (row.match(/<\/span>\s*([^<]+)<\/a>/) || [])[1];
        if (!link || !language || seen[link]) {
          return null;
        }
        seen[link] = true;
        return {
          ref: link,
          language: language,
          // some entries have no release name on the site
          name: title && title.trim() ? decodeEntities(title) : language.trim() + ' subtitle #' + link.split('-').pop()
        };
      }).filter(Boolean);
    })
    .catch(function (err) {
      // No subtitles page for this movie
      if (err.response && err.response.status === 404) {
        return [];
      }
      throw err;
    });
}

function firstSrtInZip(buffer) {
  return new Promise(function (resolve, reject) {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, function (err, zip) {
      if (err) {
        return reject(err);
      }
      zip.on('entry', function (entry) {
        if (!/\.(srt|vtt)$/i.test(entry.fileName)) {
          return zip.readEntry();
        }
        zip.openReadStream(entry, function (err, stream) {
          if (err) {
            return reject(err);
          }
          var chunks = [];
          stream.on('data', function (c) { chunks.push(c); });
          stream.on('end', function () {
            zip.close();
            resolve({ buffer: Buffer.concat(chunks), format: /\.vtt$/i.test(entry.fileName) ? 'vtt' : 'srt' });
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', function () {
        reject(new Error('no subtitle file in archive'));
      });
      zip.readEntry();
    });
  });
}

function fetch(ref) {
  if (!/^\/subtitles\/[\w-]+$/.test(ref)) {
    return Promise.reject(new Error('invalid YIFY subtitle reference'));
  }
  return axios.get(BASE + ref, { headers: HEADERS, timeout: 15000 }).then(function (res) {
    var encoded = (String(res.data).match(/data-link="([^"]+)"/) || [])[1];
    if (!encoded) {
      throw new Error('download link not found');
    }
    var zipUrl = new URL(Buffer.from(encoded, 'base64').toString('utf8'));
    if (zipUrl.protocol !== 'https:' || !/(^|\.)yts-subs\.com$/.test(zipUrl.hostname)) {
      throw new Error('unexpected subtitle host ' + zipUrl.hostname);
    }
    return axios.get(zipUrl.toString(), { headers: HEADERS, responseType: 'arraybuffer', timeout: 20000 });
  }).then(function (res) {
    return firstSrtInZip(Buffer.from(res.data));
  });
}

module.exports = {
  id: 'yify',
  name: 'YIFY Subtitles',
  description: 'Movie subtitles matched to YTS releases. No key needed. Movies only.',
  supports: { movie: true, episode: false },
  isConfigured: function () { return true; },
  search: search,
  fetch: fetch
};
