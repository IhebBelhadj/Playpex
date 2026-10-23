'use strict';

// The media library's server side (docs/media-server-plan.md §5, step 4):
// the filename parser on its corpus (test/fixtures/filenames.tsv), then the
// scanner and the admin routes on a real server with temp folders and a fake
// TMDB (offline): walk rules (hidden, extras, samples, symlinks), sidecar
// subtitles, .nfo ids, matching movies and episodes, incremental rescans
// (unchanged files neither probed nor matched again), missing files and
// folders, the admin's matches surviving rescans, ignore, the folder browser.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http');

var tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-library-')));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  library = require('../lib/library'),
  parse = require('../lib/library/parse'),
  transcode = require('../lib/transcode'),
  logger = require('../lib/logger');

var moviesDir = path.join(tmp, 'media', 'Movies'),
  showsDir = path.join(tmp, 'media', 'Shows'),
  outsideDir = path.join(tmp, 'elsewhere'),
  base = null,
  cookie = null,
  probes = 0,
  realProbe = transcode.probe;

// ── a fake TMDB ─────────────────────────────────────────────────────────────

var MOVIES = [
    { id: 27205, title: 'Inception', release_date: '2010-07-15', imdb_id: 'tt1375666' },
    { id: 603, title: 'The Matrix', release_date: '1999-03-30', imdb_id: 'tt0133093' },
    { id: 604, title: 'The Matrix Reloaded', release_date: '2003-05-15' },
    { id: 155, title: 'The Dark Knight', release_date: '2008-07-16' }
  ],
  SHOWS = [
    { id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', origin_country: ['US'],
      seasons: { 1: [1, 2, 3, 4, 5, 6, 7], 2: [1, 2, 3, 4] } },
    { id: 2996, name: 'The Office', first_air_date: '2001-07-09', origin_country: ['GB'], seasons: { 1: [1, 2] } },
    { id: 2316, name: 'The Office', first_air_date: '2005-03-24', origin_country: ['US'], seasons: { 2: [1, 2, 3] } }
  ],
  calls = 0;

function words(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
}

var catalog = {
  search: function (kind, query, year) {
    calls++;
    var list = kind === 'movie' ? MOVIES : SHOWS, q = words(query);
    return Promise.resolve(list.filter(function (r) {
      var name = words(r.title || r.name), date = r.release_date || r.first_air_date;
      return q.every(function (w) { return name.indexOf(w) !== -1; }) && (!year || date.slice(0, 4) === String(year));
    }));
  },
  movie: function (id) {
    calls++;
    var m = MOVIES.filter(function (x) { return x.id === id; })[0];
    return m ? Promise.resolve(m) : Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } }));
  },
  tv: function (id) {
    calls++;
    var s = SHOWS.filter(function (x) { return x.id === id; })[0];
    return s ? Promise.resolve(Object.assign({ external_ids: { imdb_id: 'tt' + id } }, s)) :
      Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } }));
  },
  season: function (id, season) {
    calls++;
    var s = SHOWS.filter(function (x) { return x.id === id; })[0], eps = s && s.seasons[season];
    if (!eps) {
      return Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } }));
    }
    return Promise.resolve({ episodes: eps.map(function (n) { return { id: id * 1000 + season * 100 + n, episode_number: n, name: 'Episode ' + n }; }) });
  },
  find: function () {
    calls++;
    return Promise.resolve({ movie_results: [], tv_results: [] });
  }
};

// ── helpers ─────────────────────────────────────────────────────────────────

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof bytes === 'string' ? bytes : Buffer.alloc(bytes || 1000, 1));
}

function call(method, apiPath, body, expect) {
  var payload = body === undefined ? null : JSON.stringify(body);
  return new Promise(function (resolve, reject) {
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: method,
      headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload ? { 'Content-Type': 'application/json' } : {},
        cookie ? { Cookie: cookie } : {})
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8'),
          out = { status: res.statusCode, headers: res.headers, text: raw,
            body: /json/.test(res.headers['content-type'] || '') ? JSON.parse(raw) : null };
        if (expect !== undefined && out.status !== expect) {
          return reject(new Error(method + ' ' + apiPath + ' → ' + out.status + ' ' + raw.slice(0, 300)));
        }
        resolve(out);
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function scan(folderId, force) {
  return call('POST', '/admin/library/scan', { folderId: folderId, force: force }, 200).then(function () {
    return library.idle();
  });
}

function folders() {
  return call('GET', '/admin/library', undefined, 200).then(function (res) {
    var byPath = {};
    res.body.folders.forEach(function (f) { byPath[f.path] = f; });
    return byPath;
  });
}

function files(folderId) {
  return call('GET', '/admin/library/files?limit=500' + (folderId ? '&folder=' + folderId : ''), undefined, 200).then(function (res) {
    var byPath = {};
    res.body.files.forEach(function (f) { byPath[f.relPath] = f; });
    return byPath;
  });
}

var movies, shows;

test.before(function () {
  write(path.join(moviesDir, 'Inception (2010)', 'Inception (2010).mkv'), 4000);
  write(path.join(moviesDir, 'Inception (2010)', 'Inception (2010).en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  write(path.join(moviesDir, 'Inception (2010)', 'Subs', 'French.srt'), '1\n00:00:01,000 --> 00:00:02,000\nBonjour\n');
  write(path.join(moviesDir, 'Inception (2010)', 'Sample', 'inception.mkv'), 100);
  write(path.join(moviesDir, 'Inception (2010)', 'inception-sample.mkv'), 100);
  write(path.join(moviesDir, 'Weird Name', 'whatever.mkv'), 3000);
  write(path.join(moviesDir, 'Weird Name', 'movie.nfo'), '<movie><title>x</title><uniqueid type="tmdb" default="true">603</uniqueid></movie>');
  write(path.join(moviesDir, 'Unknown.Film.2015.1080p.WEB.mkv'), 2000);
  write(path.join(moviesDir, '.hidden', 'The.Dark.Knight.2008.mkv'), 2000);
  write(path.join(moviesDir, 'notes.txt'), 'not a video');
  write(path.join(outsideDir, 'The.Dark.Knight.2008.mkv'), 2000);
  fs.symlinkSync(path.join(outsideDir, 'The.Dark.Knight.2008.mkv'), path.join(moviesDir, 'The.Dark.Knight.2008.mkv'));

  write(path.join(showsDir, 'Breaking Bad', 'Season 01', 'Breaking.Bad.S01E01.720p.mkv'), 1500);
  write(path.join(showsDir, 'Breaking Bad', 'Season 01', 'Breaking.Bad.S01E02.720p.mkv'), 1500);
  write(path.join(showsDir, 'Breaking Bad', 'Season 01', 'Subs', 'Breaking.Bad.S01E01.720p', '2_English.srt'), '1\n00:00:01,000 --> 00:00:02,000\nYo\n');
  write(path.join(showsDir, 'Breaking Bad', 'Season 02', '03 - Bit by a Dead Bee.mkv'), 1500);
  write(path.join(showsDir, 'The Office (US)', 'Season 2', 'The Office (US) - S02E01 - The Dundies.mkv'), 1500);

  transcode.probe = function () {
    probes++;
    return Promise.resolve({ duration: 60, video: 'h264', width: 1920, height: 1080, hdr: false, audio: [], subtitles: [], transcode: false });
  };
  logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });
  return server.start({
    port: 0, console: false, torrents: { engine: 'fake', discovery: false },
    library: { catalog: catalog, firstScanMs: 3600000, downloadScanMs: 50 }
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return call('POST', '/admin/setup', { username: 'admin', password: 'library-pass' }, 200);
  }).then(function () {
    return call('POST', '/auth/sign-in/username', { username: 'admin', password: 'library-pass' }, 200);
  }).then(function (res) {
    cookie = [].concat(res.headers['set-cookie'])[0].split(';')[0];
  });
});

test.after(function () {
  transcode.probe = realProbe;
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('parser: the corpus of file names (decision F)', function () {
  var rows = fs.readFileSync(path.join(__dirname, 'fixtures', 'filenames.tsv'), 'utf8').split('\n')
      .filter(function (l) { return l && l[0] !== '#'; }),
    norm = function (t) {
      return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
        .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    },
    wrong = rows.filter(function (line) {
      var f = line.split('\t'), p = parse(f[0]);
      return p.kind !== f[1] || norm(p.title) !== norm(f[2]) || (f[3] && p.year !== +f[3]) ||
        (f[1] === 'episode' && (p.season !== +f[4] || p.episode !== +f[5]));
    });
  assert.ok(rows.length >= 300, 'corpus of ' + rows.length);
  assert.deepEqual(wrong, [], wrong.length + ' names parsed wrong');
  var tagged = parse('Barbie (2023) {tmdb-346698}/Barbie (2023) {tmdb-346698}.mkv');
  assert.equal(tagged.tmdbId, '346698');
  assert.equal(parse('The.Office.S03E10.720p.WEB-DL.mkv').resolution, '720p');
  assert.deepEqual([parse('Friends - S10E17-E18 - The Last One.mkv').episode, parse('Friends - S10E17-E18 - The Last One.mkv').episodeEnd], [17, 18]);
});

test('folders: add, refused paths, the built-in download folder', function () {
  return call('POST', '/admin/library/folders', { path: moviesDir, kind: 'movies' }, 201).then(function (res) {
    movies = res.body;
    assert.equal(movies.kind, 'movies');
    assert.equal(movies.audience, 'everyone');
    return call('POST', '/admin/library/folders', { path: showsDir, kind: 'shows' }, 201);
  }).then(function (res) {
    shows = res.body;
    return Promise.all([
      call('POST', '/admin/library/folders', { path: moviesDir, kind: 'movies' }, 409),
      call('POST', '/admin/library/folders', { path: path.join(moviesDir, 'Weird Name'), kind: 'movies' }, 409),
      call('POST', '/admin/library/folders', { path: path.join(tmp, 'media'), kind: 'mixed' }, 409),
      call('POST', '/admin/library/folders', { path: path.join(tmp, 'nope'), kind: 'movies' }, 400),
      call('POST', '/admin/library/folders', { path: 'relative/dir', kind: 'movies' }, 400),
      call('POST', '/admin/library/folders', { path: outsideDir, kind: 'films' }, 400)
    ]);
  }).then(function () {
    return library.ensureDownloadFolder();
  }).then(function (builtin) {
    assert.ok(builtin.builtin);
    assert.equal(builtin.kind, 'mixed');
    return call('DELETE', '/admin/library/folders/' + builtin.id, undefined, 409);
  }).then(function () {
    return library.idle();
  });
});

test('scan: walk rules, sidecars, nfo, matches', function () {
  return Promise.all([files(movies.id), files(shows.id), folders()]).then(function (r) {
    var m = r[0], s = r[1], f = r[2];
    assert.deepEqual(Object.keys(m).sort(), ['Inception (2010)/Inception (2010).mkv', 'Unknown.Film.2015.1080p.WEB.mkv',
      'Weird Name/whatever.mkv'], 'no sample, extras, hidden file, or symlink leaving the library');

    var inception = m['Inception (2010)/Inception (2010).mkv'];
    assert.equal(inception.state, 'ok');
    assert.equal(inception.matchedBy, 'auto');
    assert.equal(inception.item.tmdbId, 27205);
    assert.equal(inception.item.imdbId, 'tt1375666');
    assert.equal(inception.probe.width, 1920);
    assert.match(inception.ref, /^f_/);
    assert.deepEqual(inception.subtitles.map(function (x) { return [x.relPath, x.language]; }), [
      ['Inception (2010)/Inception (2010).en.srt', 'en'], ['Inception (2010)/Subs/French.srt', 'fr']]);

    assert.equal(m['Weird Name/whatever.mkv'].item.tmdbId, 603);
    assert.equal(m['Weird Name/whatever.mkv'].matchedBy, 'nfo');
    assert.equal(m['Unknown.Film.2015.1080p.WEB.mkv'].state, 'unmatched');
    assert.equal(m['Unknown.Film.2015.1080p.WEB.mkv'].item, null);

    var e1 = s['Breaking Bad/Season 01/Breaking.Bad.S01E01.720p.mkv'];
    assert.deepEqual([e1.item.kind, e1.item.showTmdbId, e1.item.season, e1.item.episode, e1.item.title],
      ['episode', 1396, 1, 1, 'Breaking Bad']);
    assert.equal(e1.subtitles[0].language, 'en');
    assert.equal(s['Breaking Bad/Season 02/03 - Bit by a Dead Bee.mkv'].item.episode, 3);
    assert.equal(s['The Office (US)/Season 2/The Office (US) - S02E01 - The Dundies.mkv'].item.showTmdbId, 2316, 'the US one');

    assert.deepEqual(f[moviesDir].counts, { ok: 2, missing: 0, unmatched: 1, ignored: 0 });
    assert.deepEqual(f[showsDir].counts, { ok: 4, missing: 0, unmatched: 0, ignored: 0 });
    assert.equal(f[moviesDir].status, 'ok');
    assert.ok(f[moviesDir].lastScanAt);
  });
});

test('rescan: unchanged files are not probed or matched again; changed and gone ones are', function () {
  var before = { probes: probes, calls: calls };
  return scan().then(function () {
    assert.equal(probes, before.probes, 'no probe');
    assert.equal(calls, before.calls, 'no TMDB call');
    write(path.join(moviesDir, 'Inception (2010)', 'Inception (2010).mkv'), 5000);
    fs.renameSync(path.join(showsDir, 'Breaking Bad', 'Season 01', 'Breaking.Bad.S01E02.720p.mkv'), path.join(tmp, 'away.mkv'));
    return scan();
  }).then(function () {
    assert.equal(probes, before.probes + 1, 'the changed file only');
    return Promise.all([files(movies.id), files(shows.id)]);
  }).then(function (r) {
    assert.equal(r[0]['Inception (2010)/Inception (2010).mkv'].size, 5000);
    assert.equal(r[0]['Inception (2010)/Inception (2010).mkv'].item.tmdbId, 27205);
    var gone = r[1]['Breaking Bad/Season 01/Breaking.Bad.S01E02.720p.mkv'];
    assert.equal(gone.state, 'missing');
    assert.ok(gone.missingSince);
    return call('GET', '/media/' + gone.ref, undefined, 404).then(function () {
      fs.renameSync(path.join(tmp, 'away.mkv'), path.join(showsDir, 'Breaking Bad', 'Season 01', 'Breaking.Bad.S01E02.720p.mkv'));
      return scan(shows.id);
    }).then(function () {
      return files(shows.id);
    }).then(function (s) {
      var back = s['Breaking Bad/Season 01/Breaking.Bad.S01E02.720p.mkv'];
      assert.equal(back.id, gone.id, 'the same row (resume points, matches)');
      assert.equal(back.state, 'ok');
      assert.equal(back.missingSince, null);
    });
  });
});

test('a folder that disappears: its files are missing, then back', function () {
  var moved = path.join(tmp, 'media', 'Shows-unplugged');
  fs.renameSync(showsDir, moved);
  return scan(shows.id).then(function () {
    return Promise.all([folders(), files(shows.id)]);
  }).then(function (r) {
    assert.equal(r[0][showsDir].status, 'missing');
    assert.ok(Object.keys(r[1]).every(function (k) { return r[1][k].state === 'missing'; }));
    fs.renameSync(moved, showsDir);
    return scan(shows.id);
  }).then(function () {
    return folders();
  }).then(function (f) {
    assert.equal(f[showsDir].status, 'ok');
    assert.equal(f[showsDir].counts.ok, 4);
  });
});

test('fixing matches: the admin\'s survive rescans; unmatch; ignore', function () {
  var file;
  return files(movies.id).then(function (m) {
    file = m['Unknown.Film.2015.1080p.WEB.mkv'];
    return Promise.all([
      call('PUT', '/admin/library/files/' + file.id + '/match', { kind: 'movie', tmdbId: 999999 }, 400),
      call('PUT', '/admin/library/files/' + file.id + '/match', { kind: 'movie' }, 400),
      call('PUT', '/admin/library/files/' + file.id + '/match', { kind: 'episode', showTmdbId: 1396, season: 9, episode: 1 }, 400),
      call('PUT', '/admin/library/files/nope/match', { kind: 'movie', tmdbId: 155 }, 404)
    ]);
  }).then(function () {
    return call('PUT', '/admin/library/files/' + file.id + '/match', { kind: 'movie', tmdbId: 155 }, 200);
  }).then(function (res) {
    assert.equal(res.body.matchedBy, 'admin');
    assert.equal(res.body.state, 'ok');
    assert.equal(res.body.item.title, 'The Dark Knight');
    // ?q= finds a file by its path or its matched title; % and _ are literal
    return Promise.all(['dark knight', 'Unknown.Film', '_'].map(function (q) {
      return call('GET', '/admin/library/files?q=' + encodeURIComponent(q), undefined, 200);
    }));
  }).then(function (found) {
    assert.ok(found[0].body.files.some(function (f) { return f.id === file.id; }));
    assert.ok(found[1].body.files.some(function (f) { return f.id === file.id; }));
    assert.equal(found[0].body.total, found[0].body.files.length);
    assert.ok(found[2].body.files.every(function (f) { return f.relPath.indexOf('_') !== -1; }));
    // a changed file is parsed again, but not matched again
    write(path.join(moviesDir, 'Unknown.Film.2015.1080p.WEB.mkv'), 2500);
    return scan(movies.id, true);
  }).then(function () {
    return call('GET', '/admin/library/files/' + file.id, undefined, 200);
  }).then(function (res) {
    assert.equal(res.body.item.tmdbId, 155);
    assert.equal(res.body.matchedBy, 'admin');
    // an episode, by the admin
    return call('PUT', '/admin/library/files/' + file.id + '/match', { kind: 'episode', showTmdbId: 1396, season: 2, episode: 4 }, 200);
  }).then(function (res) {
    assert.deepEqual([res.body.item.kind, res.body.item.season, res.body.item.episode, res.body.item.episodeTitle],
      ['episode', 2, 4, 'Episode 4']);
    return call('DELETE', '/admin/library/files/' + file.id + '/match', undefined, 200);
  }).then(function (res) {
    assert.equal(res.body.state, 'unmatched');
    assert.equal(res.body.item, null);
    return call('PUT', '/admin/library/files/' + file.id + '/ignored', { ignored: true }, 200);
  }).then(function (res) {
    assert.equal(res.body.state, 'ignored');
    return scan(movies.id, true);
  }).then(function () {
    return call('GET', '/admin/library/files?state=ignored', undefined, 200);
  }).then(function (res) {
    assert.deepEqual(res.body.files.map(function (f) { return f.id; }), [file.id]);
    assert.equal(res.body.total, 1);
    return call('PUT', '/admin/library/files/' + file.id + '/ignored', { ignored: false }, 200);
  }).then(function (res) {
    assert.equal(res.body.state, 'unmatched');
  });
});

test('sidecar subtitles: listed and served as WebVTT', function () {
  return files(movies.id).then(function (m) {
    var ref = m['Inception (2010)/Inception (2010).mkv'].ref;
    return call('GET', '/media/' + ref + '/subtitles', undefined, 200).then(function (res) {
      assert.deepEqual(res.body.subtitles.map(function (x) { return x.languageName; }), ['English', 'French']);
      return call('GET', '/media/' + ref + '/subtitles/1', undefined, 200);
    }).then(function (res) {
      assert.match(res.headers['content-type'], /text\/vtt/);
      assert.match(res.text, /^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:02\.000\nBonjour/);
      return call('GET', '/media/' + ref + '/subtitles/7', undefined, 404);
    });
  });
});

test('search, folder browser, kind change, remove', function () {
  return call('GET', '/admin/library/search?kind=movie&q=matrix', undefined, 200).then(function (res) {
    assert.deepEqual(res.body.results.map(function (r) { return r.tmdbId; }), [603, 604]);
    assert.equal(res.body.results[0].year, 1999);
    return call('GET', '/admin/library/search?kind=person&q=x', undefined, 400);
  }).then(function () {
    return call('GET', '/admin/fs?path=' + encodeURIComponent(path.join(tmp, 'media')), undefined, 200);
  }).then(function (res) {
    assert.deepEqual(res.body.dirs.map(function (d) { return d.name; }), ['Movies', 'Shows']);
    assert.equal(res.body.parent, tmp);
    return call('GET', '/admin/fs', undefined, 200);
  }).then(function (res) {
    assert.ok(res.body.places.length >= 2);
    return Promise.all([
      call('GET', '/admin/fs?path=' + encodeURIComponent(path.join(tmp, 'nope')), undefined, 404),
      call('GET', '/admin/fs?path=relative', undefined, 400)
    ]);
  }).then(function () {
    return call('PATCH', '/admin/library/folders/' + movies.id, { audience: 'adults', dlna: true }, 200);
  }).then(function (res) {
    assert.equal(res.body.audience, 'adults');
    assert.equal(res.body.dlna, true);
    return call('PATCH', '/admin/library/folders/' + movies.id, { kind: 'cartoons' }, 400);
  }).then(function () {
    return call('DELETE', '/admin/library/folders/' + movies.id, undefined, 200);
  }).then(function () {
    assert.ok(fs.existsSync(path.join(moviesDir, 'Inception (2010)', 'Inception (2010).mkv')), 'nothing deleted on disk');
    return call('GET', '/admin/library/files?folder=' + movies.id, undefined, 200);
  }).then(function (res) {
    assert.equal(res.body.total, 0);
  });
});

test('a finished download: the download folder is scanned', function () {
  var downloads = path.join(tmp, 'cache', 'torrent_data');
  write(path.join(downloads, 'Inception.2010.1080p.BluRay.x264-SPARKS', 'Inception.2010.1080p.BluRay.x264-SPARKS.mkv'), 3000);
  require('../lib/events').publish('download.updated', { infoHash: 'x', state: 'seeding' });
  return new Promise(function (resolve) { setTimeout(resolve, 300); }).then(function () {
    return library.idle();
  }).then(function () {
    return folders();
  }).then(function (f) {
    var builtin = f[fs.realpathSync(downloads)];
    assert.ok(builtin && builtin.builtin);
    assert.equal(builtin.counts.ok, 1);
  });
});

test('admin only', function () {
  var saved = cookie;
  cookie = null;
  return Promise.all([
    call('GET', '/admin/library', undefined, 401),
    call('GET', '/admin/fs', undefined, 401)
  ]).then(function () { cookie = saved; }, function (err) { cookie = saved; throw err; });
});
