'use strict';

// Records the torrent sites' answers for the providers' parity test
// (test/providers.parity.test.js): runs the core's providers on the cases of
// test/helpers/recorded.js against the real sites and writes what they
// answered, cut down to the fields anyone reads, to
// test/fixtures/providers/{play,releases}.json.
//
//   node apps/server/scripts/record-providers.js
//
// Record again when a site changes its answers; the test then compares the
// plugins (plugins/torrents/*) with the core on the new answers.

var fs = require('fs'),
  os = require('os'),
  path = require('path');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-record-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');

var axios = require('axios').default,
  recorded = require('../test/helpers/recorded'),
  yts = require('../lib/providers/yts'),
  episodes = require('../lib/episodes'),
  releases = require('../lib/releases');

function pick(item, keys) {
  var out = {};
  keys.forEach(function (k) {
    if (item[k] !== undefined) {
      out[k] = item[k];
    }
  });
  return out;
}

var YTS_TORRENT = ['hash', 'quality', 'type', 'video_codec', 'bit_depth', 'audio_channels', 'seeds', 'peers', 'size_bytes', 'date_uploaded_unix'];

function ytsMovie(m) {
  var out = pick(m, ['imdb_code', 'title', 'title_long', 'title_english', 'year']);
  out.torrents = (m.torrents || []).map(function (t) { return pick(t, YTS_TORRENT); });
  return out;
}

// Each site's answer with only what the providers read (magnets cut to their hash)
function trim(host, data) {
  if (/yts|accel/.test(host)) {
    var d = data && data.data || {}, out = {};
    if (d.movie) {
      out.movie = ytsMovie(d.movie);
    }
    if (d.movies || d.movie_count !== undefined) {
      out.movie_count = d.movie_count;
      out.movies = (d.movies || []).map(ytsMovie);
    }
    return { status: data.status, data: out };
  }
  if (/eztv/.test(host)) {
    return {
      torrents_count: data.torrents_count,
      torrents: (data.torrents || []).map(function (t) {
        var out = pick(t, ['title', 'filename', 'hash', 'seeds', 'peers', 'size_bytes', 'season', 'episode', 'date_released_unix']);
        out.magnet_url = 'magnet:?xt=urn:btih:' + t.hash;
        return out;
      })
    };
  }
  if (/therarbg/.test(host)) {
    return {
      results: (data.results || []).map(function (r) { return pick(r, ['n', 'h', 's', 'se', 'le', 'c', 'a']); }),
      links: { next: data.links && data.links.next ? 'next' : null }
    };
  }
  if (/apibay/.test(host)) {
    return (Array.isArray(data) ? data : []).map(function (r) {
      return pick(r, ['name', 'info_hash', 'seeders', 'leechers', 'size', 'added', 'category']);
    });
  }
  return data;
}

var answers = {},
  real = axios.defaults.adapter;

axios.defaults.adapter = function (config) {
  return real(config).then(function (res) {
    var k = recorded.key(config.url, config.params), data = res.data;
    // the adapter's answer comes before axios parses it
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) {}
    }
    answers[k] = trim(new URL(config.url).host, data);
    return res;
  });
};

function write(name) {
  var file = path.join(recorded.DIR, name + '.json'),
    sorted = {};
  Object.keys(answers).sort().forEach(function (k) { sorted[k] = answers[k]; });
  fs.mkdirSync(recorded.DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sorted, null, 1) + '\n');
  console.log(name + ': ' + Object.keys(sorted).length + ' answers, ' + Math.round(fs.statSync(file).size / 1024) + ' KB');
  answers = {};
}

// The plugins (plugins/torrents/*) ask what the core didn't (The Pirate Bay
// and TheRARBG for movies): they run here too, on the real sites
var PLUGINS = path.join(__dirname, '..', '..', '..', 'plugins', 'torrents');

function fetch(o) {
  return axios.get(o.url, { timeout: 15000, validateStatus: function () { return true; } }).then(function (res) {
    return { status: res.status, headers: {}, body: res.data };
  });
}

var plugins = fs.readdirSync(PLUGINS).filter(function (id) {
  return fs.existsSync(path.join(PLUGINS, id, 'playpex-plugin.json'));
}).map(function (id) {
  return recorded.plugin(path.join(PLUGINS, id), fetch);
});

function play(c) {
  var t = c.title;
  return (t.kind === 'movie' ? yts.releases(t.imdbId) :
    episodes.findEpisodeTorrents(t.imdbId, t.title, t.season, t.episode)).then(function (r) {
    console.log('  ' + c.name + ': ' + (r.torrents || r).length + ' torrents');
    return Promise.all(plugins.map(function (p) {
      return Promise.resolve(p.hooks['play.collect']({ title: t })).then(function (found) {
        console.log('    ' + p.id + ': ' + found.length);
      });
    }));
  });
}

function list(c) {
  return releases.browse(c).then(function (r) {
    console.log('  ' + JSON.stringify(c) + ': ' + r.torrents.length + ' releases');
  });
}

recorded.PLAY.reduce(function (p, c) { return p.then(function () { return play(c); }); }, Promise.resolve())
  .then(function () { write('play'); })
  .then(function () {
    return recorded.RELEASES.reduce(function (p, c) { return p.then(function () { return list(c); }); }, Promise.resolve());
  })
  .then(function () { write('releases'); })
  .then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  }, function (err) {
    console.error(err);
    process.exitCode = 1;
  });
