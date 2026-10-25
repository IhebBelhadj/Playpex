'use strict';

// A throwaway Playpex server with downloads in every state, for working on the
// dashboard's Downloads page (docs/dashboard-plan.md step 2): the fake engine
// (lib/torrents/engines/fake.js) and a fake seeder in this process, so the
// torrents really download, slowly, offline. Its state lives in a temp folder;
// the admin is `admin` / `playpex-demo`. Stops on Ctrl+C.
//   node apps/server/test/helpers/downloads-server.js [--port 28492] [--rate 4096]
// Then `PLAYPEX_SERVER=http://localhost:28492 npm run dashboard`, or build the
// dashboard first: the server serves apps/server/public at its root.

var fs = require('fs'),
  os = require('os'),
  path = require('path');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-downloads-server-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';
process.env.PLAYPEX_LAN_SHARING = '0';

var server = require('../..'),
  torrents = require('../../lib/torrents/client'),
  engines = require('../../lib/torrents/engines'),
  logger = require('../../lib/logger'),
  auth = require('../../lib/auth'),
  helpers = require('./torrent');

function arg(name, fallback) {
  var i = process.argv.indexOf('--' + name);
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : fallback;
}

var PORT = arg('port', 28492),
  RATE = arg('rate', 1024),        // bytes per 20 ms tick and torrent: 50 KB/s
  UPLOAD = arg('upload', 256),     // while seeding: 12.5 KB/s
  MB = 1024 * 1024,
  seedDir = path.join(tmp, 'seed'),
  downloadDir = path.join(tmp, 'cache', 'torrent_data'),
  seeder = engines.create('fake');

// real videos where ffmpeg is there (the dashboard's player): an MKV with AC-3
// sound (a browser gets the server's HLS stream) and an MP4 (plays as it is)
function video(args, fallback) {
  var out = path.join(tmp, 'gen-' + Math.random().toString(36).slice(2) + args.pop());
  var made = require('child_process').spawnSync('ffmpeg', ['-v', 'error', '-y'].concat(args, [out]));
  return made.status === 0 ? { data: fs.readFileSync(out) } : { size: fallback };
}
var srt = Buffer.from('1\n00:00:01,000 --> 00:00:05,000\nThe swarm strip shows every piece.\n\n2\n00:00:06,000 --> 00:00:12,000\nGold is what a player reads now.\n');
var heatVideo = video(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=150', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=150',
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1000k', '-g', '50', '-c:a', 'ac3', '-ac', '6', '.mkv'], 24 * MB),
  sintelVideo = video(['-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=25:duration=60', '-f', 'lavfi', '-i', 'sine=frequency=550:duration=60',
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '600k', '-g', '50', '-c:a', 'aac', '-movflags', '+faststart', '.mp4'], 6 * MB);

var heat = helpers.make(seedDir, 'Heat.1995.1080p.BluRay.x264-AMIABLE', [Object.assign({ path: 'Heat.1995.1080p.BluRay.x264-AMIABLE.mkv' }, heatVideo), { path: 'Heat.1995.en.srt', data: srt }], { pieceLength: 256 * 1024 }),
  breaking = helpers.make(seedDir, 'Breaking.Bad.S01.1080p.BluRay.x264-ROVERS', [1, 2, 3, 4, 5].map(function (n) {
    return { path: 'Breaking.Bad.S01E0' + n + '.1080p.BluRay.x264-ROVERS.mkv', size: 4 * MB };
  }), { pieceLength: 256 * 1024 }),
  office = helpers.make(seedDir, 'The.Office.US.S02E01.720p.WEB-DL', [{ path: 'The.Office.US.S02E01.720p.WEB-DL.mkv', size: 12 * MB }], { pieceLength: 256 * 1024 }),
  dune = helpers.make(seedDir, 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.HDR', [{ path: 'Dune.Part.Two.2024.2160p.WEB-DL.mkv', size: 20 * MB }], { pieceLength: 256 * 1024 }),
  sintel = helpers.make(seedDir, 'Sintel.2010.1080p', [Object.assign({ path: 'Sintel.2010.1080p.mp4' }, sintelVideo)], { pieceLength: 256 * 1024 }),
  severance = helpers.make(seedDir, 'Severance.S02.1080p.ATVP.WEB-DL', [1, 2, 3].map(function (n) {
    return { path: 'Severance.S02E0' + n + '.1080p.mkv', size: 5 * MB };
  }), { pieceLength: 256 * 1024 }),
  seeded = [heat, breaking, office, dune, sintel, severance];

// a complete copy in the download folder: it seeds as soon as it is added
function copyData(t) {
  t.files.forEach(function (f) {
    var to = path.join(downloadDir, f.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, f.data);
  });
}

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

seeder.init({ dataDir: seedDir, stateDir: path.join(seedDir, '.state'), log: logger.child('torrent') }).then(function () {
  return Promise.all(seeded.map(function (t) {
    return seeder.add({ infoHash: t.infoHash, torrentFile: t.torrentFile, savePath: seedDir });
  }));
}).then(function () {
  copyData(breaking);
  copyData(sintel);
  return server.start({
    port: PORT, console: false, library: false,
    torrents: { engine: 'fake', discovery: false, engineOptions: { rate: RATE, upload: UPLOAD } }
  });
}).then(function () {
  server.settings.update({ downloads: { maxActive: 3, seedRatio: 3, seedMinutes: 0 } });
  return auth.setAdmin('admin', 'playpex-demo');
}).then(function () {
  var add = function (t, options) {
    return torrents.add(t.torrentFile, Object.assign({ intent: 'download', by: 'admin' }, options));
  };
  return add(breaking).then(function () {
    return add(sintel);
  }).then(function () {
    return add(heat).then(function (h) { return torrents.setLabel(h, 'Movies'); });
  }).then(function () {
    return add(dune).then(function (h) { return torrents.setLabel(h, 'Movies'); });
  }).then(function () {
    return add(severance, { files: [severance.files[0].path, severance.files[1].path] });
  }).then(function () {
    return add(office);
  }).then(function () {
    // a magnet nobody seeds: waits for its metadata
    return torrents.add('magnet:?xt=urn:btih:' + 'c9e15763f722f23e98a29decdfae341b98d53056' + '&dn=Big.Buck.Bunny.2008', { intent: 'stream', by: 'living-room-tv' });
  }).then(function () {
    // Dune: some of it, then paused
    return wait(6000).then(function () { return torrents.pause(dune.infoHash); });
  }).then(function () {
    return wait(4000).then(function () { return torrents.pause(sintel.infoHash); });
  });
}).then(function () {
  // a library folder for the Storage page (rows added here: no scan, no TMDB)
  var movies = path.join(tmp, 'Movies');
  function put(rel, data) {
    fs.mkdirSync(path.dirname(path.join(movies, rel)), { recursive: true });
    fs.writeFileSync(path.join(movies, rel), data);
  }
  put('Heat (1995)/Heat.1995.1080p.mkv', heat.files[0].data);
  put('Heat (1995)/Heat.1995.en.srt', srt);
  put('Sintel (2010)/Sintel.2010.mp4', sintel.files[0].data);
  put('Clips/unknown-clip.mkv', heat.files[0].data.slice(0, 2 * MB));
  put('Clips/notes.txt', Buffer.from('ripped from the bluray'));
  return require('../../lib/userData').services().then(function (s) {
    return s.library.addFolder({ path: fs.realpathSync(movies), kind: 'movies' }).then(function (folder) {
      return Promise.all([
        s.library.addFile(folder.id, { relPath: 'Heat (1995)/Heat.1995.1080p.mkv', size: heat.files[0].data.length }),
        s.library.addFile(folder.id, { relPath: 'Sintel (2010)/Sintel.2010.mp4', size: sintel.files[0].data.length }),
        s.library.addFile(folder.id, { relPath: 'Clips/unknown-clip.mkv', size: 2 * MB })
      ]);
    }).then(function (rows) {
      return Promise.all([
        s.library.match(rows[0].id, { kind: 'movie', tmdbId: 949 }, { title: 'Heat', year: 1995 }, 'admin'),
        s.library.match(rows[1].id, { kind: 'movie', tmdbId: 45745 }, { title: 'Sintel', year: 2010 }, 'admin')
      ]);
    });
  });
}).then(function () {
  console.log('Playpex downloads server: http://localhost:' + PORT + '/ (admin / playpex-demo)');
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});

process.on('SIGTERM', function () { process.emit('SIGINT'); });
process.on('SIGINT', function () {
  server.stop().then(function () { return seeder.close(); }).then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  });
});
