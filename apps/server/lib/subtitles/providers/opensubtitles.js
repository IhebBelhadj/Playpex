'use strict';

// Official OpenSubtitles.com REST API. Needs a free consumer key from
// https://www.opensubtitles.com/en/consumers, set as OPENSUBTITLES_API_KEY.

var axios = require('axios').default;
var settings = require('../../settings');

var BASE = 'https://api.opensubtitles.com/api/v1';

function headers() {
  return {
    'Api-Key': settings.get('providers.openSubtitlesApiKey'),
    'User-Agent': 'Playpex v0.9',
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

function search(query) {
  var imdb = String(query.imdbId).replace(/^tt0*/, '');
  var params = query.season
    ? { parent_imdb_id: imdb, season_number: query.season, episode_number: query.episode }
    : { imdb_id: imdb };

  return axios.get(BASE + '/subtitles', { headers: headers(), params: params, timeout: 15000 })
    .then(function (res) {
      return (res.data.data || []).filter(function (s) {
        return s.attributes && s.attributes.files && s.attributes.files.length;
      }).map(function (s) {
        var file = s.attributes.files[0];
        return {
          ref: String(file.file_id),
          language: s.attributes.language,
          name: file.file_name || s.attributes.release
        };
      });
    });
}

function fetch(ref) {
  if (!/^\d+$/.test(ref)) {
    return Promise.reject(new Error('invalid OpenSubtitles file id'));
  }
  return axios.post(BASE + '/download', { file_id: Number(ref), sub_format: 'srt' }, { headers: headers(), timeout: 15000 })
    .then(function (res) {
      return axios.get(res.data.link, { responseType: 'arraybuffer', timeout: 20000 });
    })
    .then(function (res) {
      return { buffer: Buffer.from(res.data), format: 'srt' };
    });
}

module.exports = {
  id: 'opensubtitles',
  name: 'OpenSubtitles.com',
  description: 'Official OpenSubtitles API. Needs OPENSUBTITLES_API_KEY (free); downloads are rate limited per day.',
  supports: { movie: true, episode: true },
  isConfigured: function () { return !!settings.get('providers.openSubtitlesApiKey'); },
  search: search,
  fetch: fetch
};
