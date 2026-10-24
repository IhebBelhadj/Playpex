// YTS: movie torrents for Play and a "Find releases" list. Runs in the
// server's sandbox (docs/plugins/server.md). Educational project: streaming
// copyrighted content via torrents may be illegal where you live.
//
//   play.collect        a movie's torrents by its IMDb id (movie_details.json)
//   releases.providers  movies: the most downloaded, or a search (list_movies.json)
//
// YTS releases are small x264 (or x265 for 2160p) encodes with AAC audio.
// yts.mx stopped answering in 2026; the API announces movies-api.accel.li as
// its new base URL. Seed counts are capped at 100, and `sort_by=seeds|peers`
// is broken (answers the newest uploads, 0 seeders): lists sort by downloads.

var MIRRORS = ['https://movies-api.accel.li', 'https://yts.lt', 'https://yts.ag'];
var PAGE_SIZE = 50;

function qs(params) {
  return Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
}

/** endpoint: 'list_movies.json' | 'movie_details.json'; the first mirror that answers */
function get(endpoint, params) {
  var i = 0;
  function attempt() {
    var url = MIRRORS[i] + '/api/v2/' + endpoint + '?' + qs(params);
    return playpex.http.request({ url: url, responseType: 'json' }).then(function (res) {
      if (res.status !== 200 || !res.body || typeof res.body !== 'object') {
        throw new Error('YTS answered HTTP ' + res.status);
      }
      return res.body;
    }).catch(function (err) {
      if (++i < MIRRORS.length) {
        return attempt();
      }
      throw err;
    });
  }
  return attempt();
}

// "Dune: Part Two (2024) [1080p] [BluRay] [x265] [10bit] [AAC 5.1] [YTS]":
// the codec tags let the core's names.describe() classify it like any release
function releaseName(movie, t) {
  var type = { bluray: 'BluRay', web: 'WEB', webrip: 'WEBRip' }[String(t.type).toLowerCase()] || t.type;
  return [
    movie.title_long || (movie.title + ' (' + movie.year + ')'),
    '[' + t.quality + ']',
    type ? '[' + type + ']' : '',
    t.video_codec ? '[' + t.video_codec + ']' : '',
    String(t.bit_depth) === '10' ? '[10bit]' : '',
    '[AAC' + (t.audio_channels ? ' ' + t.audio_channels : '') + ']',
    '[YTS]'
  ].filter(Boolean).join(' ');
}

/** A movie's torrents (no 3D ones), best quality first as YTS lists them */
function releasesOf(movie) {
  return (movie.torrents || []).filter(function (t) {
    return t.hash && t.quality !== '3D';
  }).map(function (t) {
    return {
      name: releaseName(movie, t),
      hash: String(t.hash).toLowerCase(),
      seeds: Number(t.seeds) || 0,
      peers: Number(t.peers) || 0,
      size: Number(t.size_bytes) || 0,
      added: Number(t.date_uploaded_unix) || 0
    };
  });
}

function asRelease(r) {
  var out = { title: r.name.slice(0, 300), infoHash: r.hash, seeds: r.seeds, peers: r.peers, size: r.size };
  if (r.added > 0) {
    out.uploadedAt = new Date(r.added * 1000).toISOString();
  }
  return out;
}

playpex.hooks.on('play.collect', function (input) {
  var t = input.title;
  if (t.kind !== 'movie' || !t.imdbId) {
    return [];
  }
  return get('movie_details.json', { imdb_id: t.imdbId }).then(function (body) {
    var movie = body.data && body.data.movie;
    if (!movie || movie.imdb_code !== t.imdbId) {
      return [];
    }
    // the core ranks every plugin's torrents together
    return releasesOf(movie).map(function (r) {
      return { kind: 'magnet', infoHash: r.hash, label: r.name.slice(0, 200), size: r.size, seeds: r.seeds, peers: r.peers };
    });
  });
});

// No keywords: the most downloaded movies; keywords: query_term. 50 movies a
// page, every torrent of each. A quality narrows the movies listed (the core
// filters the torrents again).
playpex.hooks.on('releases.providers', function (input) {
  if (input.kind !== 'movie') {
    return { releases: [], last: true };
  }
  var params = { limit: PAGE_SIZE, page: input.page > 1 ? input.page : 1, sort_by: 'download_count' },
    words = String(input.query || '').trim(),
    quality = input.filters && input.filters.quality;
  if (words) {
    params.query_term = words;
  }
  if (quality === '2160p' || quality === '1080p' || quality === '720p') {
    params.quality = quality;
  }
  return get('list_movies.json', params).then(function (body) {
    var data = body.data;
    if (!data) {
      throw new Error('YTS: unexpected answer');
    }
    var releases = [];
    (data.movies || []).forEach(function (movie) {
      releases = releases.concat(releasesOf(movie).map(asRelease));
    });
    return { releases: releases.slice(0, 500), last: params.page * PAGE_SIZE >= (Number(data.movie_count) || 0) };
  });
});
