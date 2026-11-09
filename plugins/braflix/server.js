// Braflix (braflix.at): direct play for movies and TV episodes.
//
// braflix.at is a React app over a list of ~30 third-party embed players, each
// opened as `<server>/movie/<tmdbId>` or `<server>/tv/<tmdbId>/<season>/<episode>`
// (the list and those paths are in its bundle, /assets/index-*.js). Two of them
// are Braflix's own and answer plain JSON from the same player code
// (`/assets/embed.js`, checked 2026-11-09):
//
//   vidsrc.party  "Brelix", Braflix's default server. GET /api/play/<path>?async=1&wait=1
//                 → { status: 'ready', result: { token, source: { quality },
//                 file: { playback: 'hls', playlist: '/v/<token>/stream' } } }, or
//                 { status: 'running', jobId } (then GET /api/jobs/<jobId>?wait=1, a long
//                 poll). The playlist (master: 1080p / 720p / 480p, an English audio and
//                 subtitle rendition; or one media playlist) names every part as
//                 /p/<token>/<base64 of the real URL> on vidsrc.party itself: the parts'
//                 throwaway hosts never reach us. Segments are MPEG-TS sent as text/html.
//   braflix.dev   "Vidsrc HD". The same API answers { result: { token: 'd0', source:
//                 { kind: 'mp4', quality }, file: { stream: '/dash-proxy?url=<CDN URL>' } } };
//                 `exclude=d0,d1…` asks for the next one ("No other source…" at the end).
//                 The URL is a signed MP4 on MovieBox's CDN (bcdnt.hakunaymatata.com) that
//                 answers ranges without a Referer, so the server reads it directly.
//
// Left out: the other embed players. Most encrypt their stream lists (vsembed /
// cineby: ChaCha20 with a WASM key that changes every 5 minutes; vidlink,
// videasy), sit behind Cloudflare challenges (2embed, xpass, wplay) or are down.
// `quality=` on braflix.dev stalls mid-answer: not used.
//
//   play.collect   a movie or an episode by its TMDB id (an episode: the show's id):
//                  the HLS stream and the MP4 files, each server behind a switch
//
// Runs in the server's sandbox (docs/plugins/server.md). Educational project:
// streaming copyrighted content may be illegal where you live.

var HLS_HOST = 'https://vidsrc.party',
  MP4_HOST = 'https://braflix.dev',
  CDN = /^https:\/\/[a-z0-9-]+\.hakunaymatata\.com\//i,
  // play.collect has 8 s: everything is asked at once and stops by 7 s
  BUDGET_MS = 7000,
  MP4_MAX = 3;

// ── helpers ─────────────────────────────────────────────────────────────────

function on(key, ctx) {
  return playpex.settings.get(key, ctx).then(function (v) { return v !== false; }, function () { return true; });
}

/** The API path of a title, or null when it has no TMDB id */
function pathOf(t) {
  if (!t || !t.tmdbId) {
    return null;
  }
  if (t.kind === 'movie') {
    return 'movie/' + t.tmdbId;
  }
  if (t.kind === 'episode' && t.season != null && t.episode) {
    return 'tv/' + t.tmdbId + '/' + t.season + '/' + t.episode;
  }
  return null;
}

/** '1080P', '720p', '360p' → the schema's qualities */
function quality(text) {
  var m = /(\d{3,4})p/i.exec(String(text || ''));
  if (!m) {
    return undefined;
  }
  var h = Number(m[1]);
  return h >= 2000 ? '2160p' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : h >= 480 ? '480p' : 'SD';
}

/** Milliseconds left before `deadline`, at least 1000 (the host's minimum), else 0 */
function left(deadline) {
  var ms = deadline - Date.now();
  return ms >= 1000 ? ms : 0;
}

/** GET JSON; a non-2xx or a body that isn't JSON → null */
function getJson(url, deadline) {
  var ms = left(deadline);
  if (!ms) {
    return Promise.resolve(null);
  }
  return playpex.http.request({ url: url, responseType: 'json', timeoutMs: ms }).then(function (r) {
    return r.status >= 200 && r.status < 300 && r.body && typeof r.body === 'object' ? r.body : null;
  }, function (err) {
    playpex.log.warn('request failed', { url: url.replace(/\?.*$/, ''), code: err && err.code });
    return null;
  });
}

/** The play API's answer: `ready` → its result; `running` → long-polled until the deadline */
function play(host, path, query, deadline) {
  return getJson(host + '/api/play/' + path + '?async=1&wait=1' + (query || ''), deadline).then(function settle(job) {
    if (!job) {
      return null;
    }
    if (job.status === 'ready') {
      return job.result || null;
    }
    if (job.status === 'running' && job.jobId) {
      return getJson(host + '/api/jobs/' + encodeURIComponent(job.jobId) + '?wait=1', deadline).then(settle);
    }
    return null;   // 'error': "No playable source…", "No other source…"
  });
}

// ── vidsrc.party: the HLS stream ────────────────────────────────────────────

function hlsSources(path, deadline) {
  return play(HLS_HOST, path, '', deadline).then(function (r) {
    var file = r && r.file;
    if (!file || file.playback !== 'hls' || typeof (file.playlist || file.stream) !== 'string') {
      return [];
    }
    var playlist = file.playlist || file.stream,
      q = quality(r.source && r.source.quality);
    if (!/^\/[A-Za-z0-9_\/.-]+$/.test(playlist)) {
      return [];
    }
    return [{
      kind: 'hls',
      url: HLS_HOST + playlist,
      label: 'Braflix' + (q ? ' ' + q : '') + ' (HLS)',
      quality: q,
      notes: ['From Braflix (vidsrc.party)']
    }];
  });
}

// ── braflix.dev: the MP4 files ──────────────────────────────────────────────

/** The CDN URL inside /dash-proxy?url=…, else braflix.dev's own proxy */
function mp4Url(stream) {
  var m = /[?&]url=([^&]+)/.exec(stream);
  if (m) {
    var direct;
    try {
      direct = decodeURIComponent(m[1]);
    } catch (e) {
      direct = '';
    }
    if (CDN.test(direct)) {
      return direct;
    }
  }
  return /^\/[^\s]*$/.test(stream) ? MP4_HOST + stream : null;
}

function mp4Sources(path, deadline) {
  var found = [], tried = [];

  function next() {
    if (found.length >= MP4_MAX || !left(deadline)) {
      return Promise.resolve(found);
    }
    var query = tried.length ? '&exclude=' + tried.map(encodeURIComponent).join(',') : '';
    return play(MP4_HOST, path, query, deadline).then(function (r) {
      var file = r && r.file;
      if (!r || !r.token || tried.indexOf(r.token) !== -1) {
        return found;
      }
      tried.push(String(r.token));
      var url = file && file.playback === 'mp4' && typeof file.stream === 'string' ? mp4Url(file.stream) : null;
      if (url) {
        var q = quality(r.source && r.source.quality);
        found.push({
          kind: 'http',
          url: url,
          label: 'Braflix' + (q ? ' ' + q : '') + ' (MP4)',
          quality: q,
          container: 'mp4',
          notes: ['From Braflix (Vidsrc HD)']
        });
      }
      return next();
    });
  }
  return next();
}

// ── hooks ───────────────────────────────────────────────────────────────────

playpex.hooks.on('play.collect', function (input, ctx) {
  var path = pathOf(input.title),
    deadline = Date.now() + BUDGET_MS;
  if (!path) {
    return [];
  }
  return Promise.all([on('hls', ctx), on('mp4', ctx)]).then(function (sw) {
    return Promise.all([
      sw[0] ? hlsSources(path, deadline) : [],
      sw[1] ? mp4Sources(path, deadline) : []
    ]);
  }).then(function (lists) {
    return lists[0].concat(lists[1]);
  });
});
