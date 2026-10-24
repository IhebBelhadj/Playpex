'use strict';

// Tracks (docs/providers-plan.md step 3) on a real server, offline: a
// generated MKV (H.264, AAC English + AC-3 French, SRT + ASS subtitles) as a
// library file and inside a multi-file torrent (fake engine and seeder) with
// a subtitle file, a separate audio file (.mka), an extra and a sample.
//
//   GET /torrents/{hash}: `chosen` (the film, an episode, a plugin's hint)
//   GET /media/{ref}/tracks: embedded audio (direct / convert) and subtitles,
//     the torrent's files that go with the video, its other videos (no sample)
//   subtitles: embedded → WebVTT on disk, 409 while the torrent downloads;
//     a torrent's .srt fetched (and selected) on demand
//   transcode ?audioRef: the separate audio file as the audio; refused for a
//     ref that isn't one of this video's
//   resume points keep audioTrack / subtitleTrack
// Skipped without ffmpeg (the files are made with it).

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  childProcess = require('child_process');

var tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-tracks-')));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var FFMPEG = childProcess.spawnSync('ffmpeg', ['-version']).status === 0 &&
  childProcess.spawnSync('ffprobe', ['-version']).status === 0;

var server = require('..'),
  torrents = require('../lib/torrents/client'),
  userData = require('../lib/userData'),
  engines = require('../lib/torrents/engines'),
  logger = require('../lib/logger'),
  helpers = require('./helpers/torrent');

var work = path.join(tmp, 'work'),
  seedDir = path.join(tmp, 'seed'),
  libraryDir = path.join(tmp, 'library'),
  seeder = engines.create('fake'),
  base = null,
  made = null,
  libraryRef = null;

function ffmpeg(args) {
  var r = childProcess.spawnSync('ffmpeg', ['-v', 'error', '-y'].concat(args));
  assert.equal(r.status, 0, String(r.stderr));
}

function call(method, apiPath, body) {
  var payload = body === undefined ? null : JSON.stringify(body);
  return new Promise(function (resolve, reject) {
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: method,
      headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload ? { 'Content-Type': 'application/json' } : {})
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, text: raw.toString('utf8'),
          body: /json/.test(res.headers['content-type'] || '') ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// The first bytes of a live transcode
function head(apiPath, bytes) {
  return new Promise(function (resolve, reject) {
    var req = http.get(new URL('/api/v1' + apiPath, base), { headers: { 'X-Playpex-Device': 'tv-1' } }, function (res) {
      var chunks = [], got = 0;
      res.on('data', function (c) {
        chunks.push(c);
        got += c.length;
        if (got >= bytes) {
          req.destroy();
          resolve({ status: res.statusCode, raw: Buffer.concat(chunks) });
        }
      });
      res.on('end', function () { resolve({ status: res.statusCode, raw: Buffer.concat(chunks) }); });
    });
    req.on('error', function (err) { if (err.code !== 'ECONNRESET') { reject(err); } });
  });
}

function byId(list, id) {
  return list.filter(function (t) { return t.id === id; })[0];
}

test.before(function () {
  if (!FFMPEG) {
    return;
  }
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.writeFileSync(path.join(work, 'en.srt'), '1\n00:00:01,000 --> 00:00:03,000\nHello from the file\n');
  fs.writeFileSync(path.join(work, 'fr.srt'), '1\n00:00:01,000 --> 00:00:03,000\nBonjour\n');
  var video = path.join(work, 'two.mkv'), mka = path.join(work, 'commentary.mka');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=6', '-i', path.join(work, 'en.srt'), '-i', path.join(work, 'fr.srt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map', '4:s',
    '-c:v', 'libx264', '-g', '25', '-c:a:0', 'aac', '-c:a:1', 'ac3', '-c:s:0', 'srt', '-c:s:1', 'ass',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fre', '-metadata:s:s:0', 'language=eng',
    '-metadata:s:s:1', 'language=fre', '-disposition:s:1', 'forced', video]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=6', '-c:a', 'aac', mka]);
  var bytes = fs.readFileSync(video);
  fs.copyFileSync(video, path.join(libraryDir, 'Two (2021).mkv'));
  made = helpers.make(seedDir, 'Two.2021.1080p', [
    { path: 'Two.2021.1080p.mkv', data: bytes },
    { path: 'Two.2021.1080p.en.srt', data: fs.readFileSync(path.join(work, 'en.srt')) },
    { path: 'Audio/Commentary.mka', data: fs.readFileSync(mka) },
    { path: 'Extras/Making of.mkv', size: 200000 },
    { path: 'Sample/sample.mkv', size: 50000 }
  ]);
  logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });
  return seeder.init({ dataDir: seedDir, stateDir: path.join(seedDir, '.state'), log: logger.child('torrent') }).then(function () {
    return seeder.add({ infoHash: made.infoHash, torrentFile: made.torrentFile, savePath: seedDir });
  }).then(function () {
    return server.start({ port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false } });
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return userData.services();
  }).then(function (s) {
    return s.library.addFolder({ path: libraryDir, kind: 'movies' }).then(function (folder) {
      return s.library.addFile(folder.id, {
        relPath: 'Two (2021).mkv', size: bytes.length,
        subtitles: [{ relPath: 'Two (2021).en.srt', language: 'en', forced: false, sdh: false }]
      });
    }).then(function (row) {
      libraryRef = 'f_' + row.id;
      fs.copyFileSync(path.join(work, 'en.srt'), path.join(libraryDir, 'Two (2021).en.srt'));
    });
  });
});

test.after(function () {
  return (base ? server.stop().then(function () { return seeder.close(); }) : Promise.resolve()).then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('a library file: its own tracks, its sidecar, embedded subtitles as WebVTT', { skip: !FFMPEG && 'no ffmpeg' }, function () {
  return call('GET', '/media/' + libraryRef + '/tracks').then(function (res) {
    assert.equal(res.status, 200, res.text);
    var t = res.body;
    assert.equal(t.probed, true);
    assert.deepEqual(t.video.map(function (v) { return [v.id, v.current]; }), [['v:0', true]]);
    assert.deepEqual(t.audio.map(function (a) { return [a.id, a.source, a.language, a.codec, a.play]; }),
      [['a:0', 'embedded', 'en', 'aac', 'direct'], ['a:1', 'embedded', 'fr', 'ac3', 'convert']]);
    assert.deepEqual(t.subtitles.map(function (s) { return [s.id, s.source, s.language, s.play, s.available, !!s.forced]; }),
      [['s:0', 'embedded', 'en', 'text', true, false], ['s:1', 'embedded', 'fr', 'text', true, true], ['s:f0', 'file', 'en', 'text', true, false]]);
    return Promise.all([
      call('GET', '/media/' + libraryRef + '/subtitles/embedded/0'),
      call('GET', '/media/' + libraryRef + '/subtitles/embedded/1'),
      call('GET', '/media/' + libraryRef + '/subtitles/embedded/7'),
      call('GET', '/media/' + libraryRef + '/subtitles/file/f0'),
      call('GET', '/media/' + libraryRef + '/subtitles/file/f9')
    ]);
  }).then(function (r) {
    assert.equal(r[0].status, 200);
    assert.match(r[0].headers['content-type'], /text\/vtt/);
    assert.match(r[0].text, /^WEBVTT[\s\S]*Hello from the file/);
    assert.match(r[1].text, /Bonjour/);
    assert.equal(r[2].status, 404);
    assert.match(r[3].text, /^WEBVTT[\s\S]*Hello from the file/);
    assert.equal(r[4].status, 404);
  });
});

test('a torrent: the server chooses the file', { skip: !FFMPEG && 'no ffmpeg' }, function () {
  var hash = made.infoHash;
  return call('POST', '/torrents', { link: made.magnet }).then(function (res) {
    assert.equal(res.status, 200);
    return helpers.until(function () {
      return call('GET', '/torrents/' + hash).then(function (r) { return r.body.files && r.body; });
    }, 10000, 'the files');
  }).then(function (t) {
    assert.equal(t.chosen, 'Two.2021.1080p/Two.2021.1080p.mkv');
    return Promise.all([
      call('GET', '/torrents/' + hash + '?fileIndex=3'),
      call('GET', '/torrents/' + hash + '?fileName=Making%20of.mkv'),
      call('GET', '/torrents/' + hash + '?season=1&episode=2'),
      call('GET', '/torrents/' + hash + '?fileIndex=1')
    ]);
  }).then(function (r) {
    assert.equal(r[0].body.chosen, 'Two.2021.1080p/Extras/Making of.mkv');
    assert.equal(r[1].body.chosen, 'Two.2021.1080p/Extras/Making of.mkv');
    assert.equal(r[2].body.chosen, 'Two.2021.1080p/Two.2021.1080p.mkv', 'one video that isn\'t an extra: that one');
    assert.equal(r[3].body.chosen, 'Two.2021.1080p/Two.2021.1080p.mkv', 'a hint that isn\'t a video is ignored');
  });
});

test('a torrent: tracks, files fetched on demand, the separate audio file', { skip: !FFMPEG && 'no ffmpeg' }, function () {
  var hash = made.infoHash, files, videoRef, tracks;
  return call('GET', '/torrents/' + hash).then(function (r) {
    files = r.body.files;
    videoRef = files[0].ref;
    return call('GET', '/media/' + videoRef + '/tracks');
  }).then(function (res) {
    assert.equal(res.status, 200, res.text);
    tracks = res.body;
    assert.deepEqual(tracks.video.map(function (v) { return [v.id, v.kind || null, v.current]; }),
      [['v:0', null, true], ['v:f3', 'extra', false]], 'the extra, not the sample');
    assert.deepEqual(tracks.audio.map(function (a) { return [a.id, a.source, a.play]; }),
      [['a:0', 'embedded', 'direct'], ['a:1', 'embedded', 'convert'], ['a:f2', 'file', 'convert']]);
    assert.equal(byId(tracks.audio, 'a:f2').title, 'Commentary');
    assert.equal(byId(tracks.audio, 'a:f2').ref, files[2].ref);
    var embedded = byId(tracks.subtitles, 's:0'), file = byId(tracks.subtitles, 's:f1');
    assert.equal(embedded.available, false, 'a torrent still downloading');
    assert.equal(embedded.note, 'Ready when the download finishes');
    assert.deepEqual([file.language, file.available, file.play], ['en', true, 'text']);
    return Promise.all([
      call('GET', '/media/' + videoRef + '/subtitles/embedded/0'),
      call('GET', '/media/' + videoRef + '/subtitles/file/f1'),
      call('GET', '/media/' + videoRef + '/subtitles/file/f2')
    ]);
  }).then(function (r) {
    assert.equal(r[0].status, 409);
    assert.equal(r[0].body.code, 'CONFLICT');
    assert.equal(r[1].status, 200, r[1].text);
    assert.match(r[1].text, /^WEBVTT[\s\S]*Hello from the file/);
    assert.equal(r[2].status, 404, 'an audio file is no subtitle track');
    var selected = torrents.get(hash).selectedFiles;
    assert.ok(selected.indexOf(files[1].path) !== -1, 'the subtitle file is fetched: ' + JSON.stringify(selected));
    return Promise.all([
      call('GET', '/media/' + videoRef + '/transcode?audioRef=' + files[3].ref),
      call('GET', '/media/' + videoRef + '/transcode?audioRef=t_' + '0'.repeat(40) + '_' + '0'.repeat(16))
    ]);
  }).then(function (r) {
    assert.equal(r[0].status, 400, 'a video is no audio track');
    assert.equal(r[1].status, 400);
    return head('/media/' + videoRef + '/transcode?t=0&audioRef=' + files[2].ref, 32 * 1024);
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.ok(res.raw.slice(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'a Matroska stream');
    var selected = torrents.get(hash).selectedFiles;
    assert.ok(selected.indexOf(files[2].path) !== -1, 'the audio file is fetched');
    // reading the video again keeps its tracks selected (a stream download keeps one video)
    return call('GET', '/media/' + videoRef + '/probe');
  }).then(function () {
    var selected = torrents.get(hash).selectedFiles;
    assert.deepEqual(selected.slice().sort(), [files[0].path, files[1].path, files[2].path].sort());
    return call('DELETE', '/media/' + videoRef);
  });
});

test('resume points keep the tracks', { skip: !FFMPEG && 'no ffmpeg' }, function () {
  return userData.services().then(function (s) {
    return s.profiles.create({ name: 'Tracks' });
  }).then(function (profile) {
    var url = '/profiles/' + profile.id + '/progress/movie/550';
    return call('PUT', url, { positionS: 600, durationS: 6000, fileId: libraryRef.slice(2), audioTrack: 'a:1', subtitleTrack: 's:f0' })
      .then(function (res) {
        assert.equal(res.status, 200, res.text);
        assert.equal(res.body.progress.audioTrack, 'a:1');
        return call('GET', url);
      }).then(function (res) {
        assert.equal(res.body.resume.audioTrack, 'a:1');
        assert.equal(res.body.resume.subtitleTrack, 's:f0');
        return call('PUT', url, { positionS: 700, durationS: 6000, audioTrack: 'x'.repeat(40) });
      }).then(function (res) {
        assert.equal(res.status, 400);
      });
  });
});
