'use strict';

// OpenSubtitles catalog through Stremio's public OpenSubtitles v3 addon.
// No API key; movies and episodes by IMDb id; files are served as UTF-8 SRT.

var axios = require('axios').default;

var BASE = 'https://opensubtitles-v3.strem.io';

function search(query) {
  var path = query.season
    ? '/subtitles/series/' + query.imdbId + ':' + query.season + ':' + query.episode + '.json'
    : '/subtitles/movie/' + query.imdbId + '.json';

  return axios.get(BASE + path, { timeout: 15000 }).then(function (res) {
    return (res.data.subtitles || []).map(function (s) {
      return {
        ref: s.url,
        language: s.lang,
        name: s.subtitleFileName || s.movieReleaseName || ('Subtitle ' + s.id)
      };
    });
  });
}

function fetch(ref) {
  var url = new URL(ref);
  if (url.protocol !== 'https:' || !/(^|\.)strem\.io$/.test(url.hostname)) {
    return Promise.reject(new Error('unexpected subtitle host ' + url.hostname));
  }
  return axios.get(url.toString(), { responseType: 'arraybuffer', timeout: 20000 }).then(function (res) {
    return { buffer: Buffer.from(res.data), format: 'srt' };
  });
}

module.exports = {
  id: 'opensubtitles-stremio',
  name: 'OpenSubtitles (free)',
  description: 'OpenSubtitles catalog via the Stremio addon. No key needed.',
  supports: { movie: true, episode: true },
  isConfigured: function () { return true; },
  search: search,
  fetch: fetch
};
