'use strict';

// Wyzie Subs (open-source subtitle aggregator, https://sub.wyzie.io).
// Needs a free key from https://store.wyzie.io/redeem, set as WYZIE_API_KEY.

var axios = require('axios').default;

var BASE = 'https://sub.wyzie.io';

function search(query) {
  var params = { id: query.imdbId, format: 'srt', key: process.env.WYZIE_API_KEY };
  if (query.season) {
    params.season = query.season;
    params.episode = query.episode;
  }
  return axios.get(BASE + '/search', { params: params, timeout: 20000 }).then(function (res) {
    return (Array.isArray(res.data) ? res.data : []).map(function (s) {
      return {
        ref: s.url,
        language: s.language || s.display,
        name: (s.release || s.fileName || s.display || 'Subtitle') + (s.source ? ' · ' + s.source : '')
      };
    });
  });
}

function fetch(ref) {
  var url = new URL(ref);
  if (url.protocol !== 'https:' || !/(^|\.)wyzie\.(io|ru)$/.test(url.hostname)) {
    return Promise.reject(new Error('unexpected subtitle host ' + url.hostname));
  }
  return axios.get(url.toString(), { responseType: 'arraybuffer', timeout: 20000 }).then(function (res) {
    return { buffer: Buffer.from(res.data), format: /\.vtt(\?|$)/i.test(url.pathname) ? 'vtt' : 'srt' };
  });
}

module.exports = {
  id: 'wyzie',
  name: 'Wyzie Subs',
  description: 'Open-source aggregator of several subtitle sites. Needs WYZIE_API_KEY (free).',
  supports: { movie: true, episode: true },
  isConfigured: function () { return !!process.env.WYZIE_API_KEY; },
  search: search,
  fetch: fetch
};
