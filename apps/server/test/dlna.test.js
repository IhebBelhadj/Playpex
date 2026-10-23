'use strict';

// The DLNA server (lib/dlna, media-server plan step 8) on a real server with
// temp library folders: SSDP answers (unicast on a test port), the device
// description, ContentDirectory's Browse (root, Movies, TV shows → seasons →
// episodes, Folders as on disk, metadata, paging, unknown objects), streaming
// with DLNA headers and ranges, sidecar .srt, write actions refused, eventing,
// the rules (only DLNA folders of audience everyone, LAN Host names), a
// library change, and turning it off.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  dgram = require('dgram');

var tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-dlna-')));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';
delete process.env.PLAYPEX_DLNA;

var server = require('..'),
  settings = require('../lib/settings'),
  events = require('../lib/events'),
  dlna = require('../lib/dlna'),
  tree = require('../lib/dlna/tree'),
  xml = require('../lib/dlna/xml'),
  sessions = require('../lib/sessions'),
  userData = require('../lib/userData'),
  logger = require('../lib/logger');

var root = path.join(tmp, 'library'),
  SSDP_PORT = 30000 + (process.pid % 20000),
  movieData = Buffer.alloc(300000, 3),
  info = null,
  base = null,
  ids = {};

function request(method, urlPath, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    var req = http.request(new URL(urlPath, base), {
      method: method,
      agent: false,
      headers: Object.assign({ 'User-Agent': 'TestRenderer/1.0' }, options.headers)
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

function soap(service, action, args) {
  var type = 'urn:schemas-upnp-org:service:' + service + ':1';
  var body = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    '<u:' + action + ' xmlns:u="' + type + '">' + Object.keys(args || {}).map(function (k) {
      return '<' + k + '>' + xml.escape(args[k]) + '</' + k + '>';
    }).join('') + '</u:' + action + '></s:Body></s:Envelope>';
  return request('POST', '/dlna/control/' + service, {
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: '"' + type + '#' + action + '"' },
    body: body
  });
}

// Browse → { total, objects: [{ tag, id, parentID, title, childCount, res, upnpClass, captions }] }
function browse(id, flag, start, count) {
  return soap('ContentDirectory', 'Browse', {
    ObjectID: id, BrowseFlag: flag || 'BrowseDirectChildren', Filter: '*',
    StartingIndex: start || 0, RequestedCount: count || 0, SortCriteria: ''
  }).then(function (res) {
    if (res.status !== 200) {
      return { status: res.status, text: res.text };
    }
    var result = xml.unescape(/<Result>([\s\S]*)<\/Result>/.exec(res.text)[1]),
      objects = [],
      re = /<(container|item)\b([^>]*)>([\s\S]*?)<\/\1>/g,
      m;
    while ((m = re.exec(result))) {
      var attr = function (name) {
        var a = new RegExp(' ' + name + '="([^"]*)"').exec(m[2]);
        return a ? xml.unescape(a[1]) : null;
      };
      var res0 = /<res\b([^>]*)>([^<]*)<\/res>/.exec(m[3]);
      objects.push({
        tag: m[1],
        id: attr('id'),
        parentID: attr('parentID'),
        childCount: attr('childCount'),
        title: xml.unescape(/<dc:title>([^<]*)<\/dc:title>/.exec(m[3])[1]),
        upnpClass: /<upnp:class>([^<]*)</.exec(m[3])[1],
        res: res0 ? { attrs: res0[1], url: xml.unescape(res0[2]) } : null,
        captions: (m[3].match(/<sec:CaptionInfoEx[^>]*>[^<]*</g) || []).length,
        art: /<upnp:albumArtURI[^>]*>([^<]*)</.test(m[3])
      });
    }
    return {
      status: 200,
      total: Number(/<TotalMatches>(\d+)</.exec(res.text)[1]),
      returned: Number(/<NumberReturned>(\d+)</.exec(res.text)[1]),
      updateId: Number(/<UpdateID>(\d+)</.exec(res.text)[1]),
      objects: objects
    };
  });
}

function titles(page) {
  return page.objects.map(function (o) { return o.title; });
}

function write(rel, data) {
  var full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
}

test.before(function () {
  write('Movies/Movie (2020)/movie.mkv', movieData);
  write('Movies/Movie (2020)/movie.en.srt', '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  write('Movies/Clips/holiday.mp4', Buffer.alloc(1000, 1));
  write('Shows/Show/Season 1/Show.S01E02.mkv', Buffer.alloc(1000, 2));
  write('Shows/Show/Season 1/Show.S01E01.mkv', Buffer.alloc(1000, 2));
  write('Adults/film.mkv', Buffer.alloc(1000, 4));
  write('Private/secret.mkv', Buffer.alloc(1000, 5));

  logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });
  settings.load();
  settings.update({ dlna: { enabled: true } });
  return userData.services().then(function (s) {
    var lib = s.library;
    function folder(name, kind, audience, inDlna) {
      return lib.addFolder({ path: path.join(root, name), kind: kind, audience: audience, dlna: inDlna });
    }
    function file(folderRow, relPath, size, extra) {
      return lib.addFile(folderRow.id, Object.assign({ relPath: relPath, size: size, state: 'ok' }, extra));
    }
    return Promise.all([
      folder('Movies', 'movies', 'everyone', true),
      folder('Shows', 'shows', 'everyone', true),
      folder('Adults', 'movies', 'adults', true),
      folder('Private', 'movies', 'everyone', false)
    ]).then(function (f) {
      ids.movies = f[0].id;
      ids.shows = f[1].id;
      return Promise.all([
        file(f[0], 'Movie (2020)/movie.mkv', movieData.length, {
          probe: { duration: 5400.5, width: 1920, height: 1080 },
          subtitles: [{ relPath: 'Movie (2020)/movie.en.srt', language: 'en', forced: false }]
        }),
        file(f[0], 'Clips/holiday.mp4', 1000, { state: 'unmatched' }),
        file(f[1], 'Show/Season 1/Show.S01E02.mkv', 1000),
        file(f[1], 'Show/Season 1/Show.S01E01.mkv', 1000),
        file(f[2], 'film.mkv', 1000),
        file(f[3], 'secret.mkv', 1000)
      ]);
    }).then(function (files) {
      ids.movie = files[0].id;
      ids.clip = files[1].id;
      ids.adult = files[4].id;
      ids.secret = files[5].id;
      var details = { title: 'Movie', year: 2020, artwork: { posterPath: '/poster.jpg' } };
      return Promise.all([
        lib.match(files[0].id, { kind: 'movie', tmdbId: 10 }, details, 'auto'),
        lib.match(files[2].id, { kind: 'episode', showTmdbId: 20, season: 1, episode: 2 }, { title: 'Show', year: 2019, episodeTitle: 'Second' }, 'auto'),
        lib.match(files[3].id, { kind: 'episode', showTmdbId: 20, season: 1, episode: 1 }, { title: 'Show', year: 2019, episodeTitle: 'First' }, 'auto'),
        lib.match(files[4].id, { kind: 'movie', tmdbId: 30 }, { title: 'Adult film', year: 2021 }, 'auto'),
        lib.match(files[5].id, { kind: 'movie', tmdbId: 40 }, { title: 'Secret', year: 2022 }, 'auto')
      ]);
    });
  }).then(function () {
    return server.start({ port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false },
      dlna: { port: 0, ssdpPort: SSDP_PORT, lan: true } });
  }).then(function (started) {
    info = started;
    return dlna.ready();
  }).then(function () {
    var status = dlna.status();
    assert.equal(status.http.state, 'listening');
    base = 'http://127.0.0.1:' + status.http.port;
  });
});

test.after(function () {
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('SSDP: an M-SEARCH for a MediaServer is answered with the description, others are not', function () {
  var sock = dgram.createSocket('udp4'), answers = [];
  sock.on('message', function (msg) { answers.push(msg.toString('utf8')); });
  function search(st) {
    var msg = 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nST: ' + st + '\r\n\r\n';
    sock.send(Buffer.from(msg), SSDP_PORT, '127.0.0.1');
  }
  return new Promise(function (resolve) { sock.bind(0, '127.0.0.1', resolve); }).then(function () {
    search('urn:schemas-upnp-org:device:MediaRenderer:1');
    search('urn:schemas-upnp-org:device:MediaServer:1');
    return new Promise(function (resolve) { setTimeout(resolve, 400); });
  }).then(function () {
    sock.close();
    assert.equal(answers.length, 1, 'no answer for a renderer search');
    assert.match(answers[0], /^HTTP\/1\.1 200 OK/);
    assert.match(answers[0], /\r\nST: urn:schemas-upnp-org:device:MediaServer:1\r\n/);
    assert.ok(answers[0].indexOf('LOCATION: ' + base + '/dlna/description.xml') !== -1, answers[0]);
    assert.ok(answers[0].indexOf('USN: ' + dlna.udnOf(info.id) + '::urn:schemas-upnp-org:device:MediaServer:1') !== -1);
  });
});

test('the device description names the server and its services', function () {
  return request('GET', '/dlna/description.xml').then(function (res) {
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/xml/);
    assert.ok(res.text.indexOf('<friendlyName>' + xml.escape(settings.get('general.serverName')) + '</friendlyName>') !== -1);
    assert.ok(res.text.indexOf('<UDN>' + dlna.udnOf(info.id) + '</UDN>') !== -1);
    assert.match(dlna.udnOf(info.id), /^uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    ['ContentDirectory', 'ConnectionManager', 'X_MS_MediaReceiverRegistrar'].forEach(function (name) {
      assert.ok(res.text.indexOf('<controlURL>/dlna/control/' + name + '</controlURL>') !== -1, name);
    });
    return request('GET', '/dlna/ContentDirectory.xml');
  }).then(function (res) {
    assert.match(res.text, /<name>Browse<\/name>/);
  });
});

test('Browse: root, Movies, TV shows → seasons → episodes; no adults-only or non-DLNA folder', function () {
  return browse('0').then(function (page) {
    assert.deepEqual(titles(page), ['Movies', 'TV shows', 'Recently added', 'Folders']);
    assert.equal(page.objects[0].childCount, '1');
    return browse('movies');
  }).then(function (page) {
    assert.deepEqual(titles(page), ['Movie (2020)']);
    var movie = page.objects[0];
    assert.equal(movie.upnpClass, 'object.item.videoItem.movie');
    assert.equal(movie.parentID, 'movies');
    assert.ok(movie.art, 'a poster');
    assert.match(movie.res.attrs, /protocolInfo="http-get:\*:video\/x-matroska:DLNA\.ORG_OP=01;/);
    assert.match(movie.res.attrs, /duration="1:30:00\.500"/);
    assert.match(movie.res.attrs, /resolution="1920x1080"/);
    assert.equal(movie.res.url, base + '/dlna/media/' + ids.movie + '.mkv');
    assert.equal(movie.captions, 1, 'the sidecar .srt');
    return browse('shows');
  }).then(function (page) {
    assert.deepEqual(titles(page), ['Show (2019)']);
    return browse(page.objects[0].id);
  }).then(function (page) {
    assert.deepEqual(titles(page), ['Season 1']);
    return browse(page.objects[0].id);
  }).then(function (page) {
    assert.deepEqual(titles(page), ['S01E01 - First', 'S01E02 - Second']);
    return browse('recent');
  }).then(function (page) {
    var all = titles(page).join(' ');
    assert.equal(page.total, 4);
    assert.doesNotMatch(all, /Adult|Secret|film|secret/);
  });
});

test('Browse: Folders as on disk, levels, metadata, paging, unknown objects', function () {
  var movieFolder;
  return browse('folders').then(function (page) {
    assert.deepEqual(titles(page), ['Movies', 'Shows'], 'not the adults-only one, not the one left out of DLNA');
    movieFolder = page.objects[0];
    assert.equal(movieFolder.childCount, '2');
    return browse(movieFolder.id);
  }).then(function (page) {
    assert.deepEqual(titles(page), ['Clips', 'Movie (2020)']);
    assert.equal(page.objects[0].id, 'folders/' + ids.movies + '/' + tree.encodeDir('Clips'));
    return browse(page.objects[0].id);
  }).then(function (page) {
    assert.deepEqual(titles(page), ['holiday'], 'an unmatched file by its name');
    assert.equal(page.objects[0].parentID, 'folders/' + ids.movies + '/' + tree.encodeDir('Clips'));
    return browse(page.objects[0].id, 'BrowseMetadata');
  }).then(function (page) {
    assert.equal(page.total, 1);
    assert.equal(page.objects[0].title, 'holiday');
    return browse('0', 'BrowseMetadata');
  }).then(function (page) {
    assert.equal(page.objects[0].parentID, '-1');
    assert.equal(page.objects[0].childCount, '4');
    return browse('0', 'BrowseDirectChildren', 1, 2);
  }).then(function (page) {
    assert.deepEqual([page.total, page.returned], [4, 2]);
    assert.deepEqual(titles(page), ['TV shows', 'Recently added']);
    return Promise.all([
      browse('folders/nope'),
      browse('movies|' + ids.adult, 'BrowseMetadata'),
      browse('folders/' + ids.movies + '/' + tree.encodeDir('../..')),
      browse('0', 'BrowseSomething')
    ]);
  }).then(function (r) {
    assert.equal(r[0].status, 500);
    assert.match(r[0].text, /<errorCode>701<\/errorCode>/);
    assert.match(r[1].text, /<errorCode>701<\/errorCode>/, 'an adults-only file under Movies');
    assert.match(r[2].text, /<errorCode>701<\/errorCode>/);
    assert.match(r[3].text, /<errorCode>402<\/errorCode>/);
  });
});

test('streaming: ranges, HEAD, DLNA headers, Samsung captions, the .srt; other files 404', function () {
  var url = '/dlna/media/' + ids.movie + '.mkv';
  return request('GET', url, { headers: { Range: 'bytes=100-199', 'getcaptionInfo.sec': '1' } }).then(function (res) {
    assert.equal(res.status, 206);
    assert.equal(res.raw.length, 100);
    assert.equal(res.headers['content-range'], 'bytes 100-199/' + movieData.length);
    assert.equal(res.headers['content-type'], 'video/x-matroska');
    assert.equal(res.headers['transfermode.dlna.org'], 'Streaming');
    assert.match(res.headers['contentfeatures.dlna.org'], /^DLNA\.ORG_OP=01;DLNA\.ORG_CI=0;DLNA\.ORG_FLAGS=0170/);
    assert.equal(res.headers['captioninfo.sec'], base + '/dlna/subtitles/' + ids.movie + '/0.srt');
    var played = sessions.list().filter(function (s) { return s.ref === 'f_' + ids.movie; })[0];
    assert.ok(played, 'the Activity page sees it');
    assert.match(played.client, /^DLNA \(TestRenderer/);
    return request('HEAD', url);
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.equal(Number(res.headers['content-length']), movieData.length);
    assert.equal(res.raw.length, 0);
    return request('GET', '/dlna/subtitles/' + ids.movie + '/0.srt');
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.match(res.text, /Hello/);
    return Promise.all([
      request('GET', '/dlna/media/' + ids.adult + '.mkv'),
      request('GET', '/dlna/media/' + ids.secret + '.mkv'),
      request('GET', '/dlna/media/../../etc/passwd'),
      request('GET', '/dlna/subtitles/' + ids.movie + '/1.srt'),
      request('GET', url, { headers: { Range: 'bytes=999999999-' } })
    ]);
  }).then(function (r) {
    assert.deepEqual(r.map(function (x) { return x.status; }), [404, 404, 404, 404, 416]);
  });
});

test('write actions and Search are refused; Samsung and Microsoft extras answer', function () {
  return Promise.all([
    soap('ContentDirectory', 'DestroyObject', { ObjectID: 'movies|' + ids.movie }),
    soap('ContentDirectory', 'CreateObject', { ContainerID: '0', Elements: '' }),
    soap('ContentDirectory', 'Search', { ContainerID: '0', SearchCriteria: '*' }),
    soap('ContentDirectory', 'X_GetFeatureList', {}),
    soap('ContentDirectory', 'X_SetBookmark', { ObjectID: 'movies|' + ids.movie, PosSecond: '10' }),
    soap('ConnectionManager', 'GetProtocolInfo', {}),
    soap('X_MS_MediaReceiverRegistrar', 'IsAuthorized', { DeviceID: '' }),
    soap('ContentDirectory', 'GetSystemUpdateID', {})
  ]).then(function (r) {
    [0, 1, 2].forEach(function (i) {
      assert.equal(r[i].status, 500);
      assert.match(r[i].text, /<errorCode>401<\/errorCode>/);
    });
    assert.match(xml.unescape(r[3].text), /samsung\.com_BASICVIEW/);
    assert.equal(r[4].status, 200);
    assert.match(r[5].text, /<Source>[^<]*video\/x-matroska/);
    assert.match(r[6].text, /<Result>1<\/Result>/);
    assert.match(r[7].text, /<Id>\d+<\/Id>/);
    assert.ok(fs.existsSync(path.join(root, 'Movies/Movie (2020)/movie.mkv')), 'nothing deleted');
  });
});

test('a foreign Host is refused (DNS rebinding)', function () {
  return request('GET', '/dlna/description.xml', { headers: { Host: 'evil.example' } }).then(function (res) {
    assert.equal(res.status, 403);
  });
});

test('eventing: a subscriber gets SystemUpdateID, then a change; callbacks only to itself', function () {
  var received = [], sink = http.createServer(function (req, res) {
    var body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      received.push({ method: req.method, sid: req.headers.sid, seq: req.headers.seq, body: body });
      res.end();
    });
  }), sid;
  return new Promise(function (resolve) { sink.listen(0, '127.0.0.1', resolve); }).then(function () {
    return request('SUBSCRIBE', '/dlna/events/ContentDirectory', { headers: {
      CALLBACK: '<http://127.0.0.1:' + sink.address().port + '/event>', NT: 'upnp:event', TIMEOUT: 'Second-600'
    } });
  }).then(function (res) {
    assert.equal(res.status, 200);
    sid = res.headers.sid;
    assert.match(sid, /^uuid:/);
    assert.equal(res.headers.timeout, 'Second-600');
    return request('SUBSCRIBE', '/dlna/events/ContentDirectory', { headers: {
      CALLBACK: '<http://10.1.2.3:80/event>', NT: 'upnp:event'
    } });
  }).then(function (res) {
    assert.equal(res.status, 412, 'a callback to another address');
    return new Promise(function (resolve) { setTimeout(resolve, 300); });
  }).then(function () {
    assert.equal(received.length, 1);
    assert.deepEqual([received[0].method, received[0].sid, received[0].seq], ['NOTIFY', sid, '0']);
    assert.match(received[0].body, /<SystemUpdateID>\d+<\/SystemUpdateID>/);
    events.publish('library.changed', { folderId: null });
    return new Promise(function (resolve) { setTimeout(resolve, 2500); });
  }).then(function () {
    assert.equal(received.length, 2, 'the change, moderated');
    assert.equal(received[1].seq, '1');
    return request('UNSUBSCRIBE', '/dlna/events/ContentDirectory', { headers: { SID: sid } });
  }).then(function (res) {
    assert.equal(res.status, 200);
    sink.close();
  });
});

test('a folder taken out of DLNA disappears at once; SystemUpdateID moves', function () {
  var before;
  return browse('folders').then(function (page) {
    before = page.updateId;
    return userData.services();
  }).then(function (s) {
    return s.library.updateFolder(ids.shows, { dlna: false });
  }).then(function () {
    events.publish('library.changed', { folderId: ids.shows });
    return browse('folders');
  }).then(function (page) {
    assert.deepEqual(titles(page), ['Movies']);
    assert.ok(page.updateId > before);
    return browse('shows');
  }).then(function (page) {
    assert.equal(page.total, 0);
  });
});

test('turned off: the listener closes; the status says why', function () {
  settings.update({ dlna: { enabled: false } });
  return dlna.refresh().then(function () {
    var status = dlna.status();
    assert.deepEqual([status.enabled, status.reason, status.http.state], [false, 'disabled', 'off']);
    return request('GET', '/dlna/description.xml').then(function () {
      assert.fail('still listening');
    }, function (err) {
      assert.equal(err.code, 'ECONNREFUSED');
    });
  });
});
