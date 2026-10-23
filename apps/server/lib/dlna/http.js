'use strict';

// The DLNA server's HTTP side (docs/media-server-plan.md §7, decision I): its
// own listener on `dlna.port` (28472), never the API port, so the API stays
// authenticated everywhere. It knows only read-only things: descriptions,
// the ContentDirectory / ConnectionManager control and eventing, the files
// of DLNA folders, their sidecar .srt subtitles and posters.
//
//   GET  /dlna/description.xml                 device description
//   GET  /dlna/<Service>.xml                   service descriptions (SCPD)
//   POST /dlna/control/<Service>               SOAP actions (Browse…)
//   SUBSCRIBE | UNSUBSCRIBE /dlna/events/<Service>   GENA eventing
//   GET | HEAD /dlna/media/<fileId>.<ext>      the file, byte ranges
//   GET  /dlna/subtitles/<fileId>/<index>.srt  a sidecar subtitle
//   GET  /dlna/art/<tmdb image name>           a TMDB poster / still through the server
//
// Every request: a loopback / private / link-local sender (else 403), an
// allowed Host (DNS rebinding), and noted for the dashboard's "seen by".

var express = require('express'),
  http = require('http'),
  crypto = require('crypto'),
  path = require('path'),
  axios = require('axios'),
  rangeParser = require('range-parser'),
  pump = require('pump'),
  xml = require('./xml'),
  tree = require('./tree'),
  descriptions = require('./descriptions'),
  media = require('../media'),
  sessions = require('../sessions'),
  middleware = require('../middleware'),
  discovery = require('../discovery'),
  log = require('../logger').child('dlna');

var FLAGS = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
  MIME = {
    '.mkv': 'video/x-matroska',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.avi': 'video/x-msvideo',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.ts': 'video/mp2t',
    '.m2ts': 'video/vnd.dlna.mpeg-tts',
    '.wmv': 'video/x-ms-wmv'
  },
  ART_SIZE = 'w342',
  ART_CACHE = 300,
  MAX_SUBSCRIPTIONS = 100,
  EVENT_MODERATION_MS = 2000;

function mimeOf(relPath) {
  return MIME[path.extname(relPath).toLowerCase()] || 'video/mpeg';
}

function protocolInfo(mime) {
  return 'http-get:*:' + mime + ':' + FLAGS;
}

// What the server serves, for GetProtocolInfo
var SOURCE_PROTOCOLS = Object.keys(MIME).map(function (ext) { return MIME[ext]; })
  .filter(function (m, i, all) { return all.indexOf(m) === i; }).map(protocolInfo)
  .concat(['http-get:*:text/srt:*', 'http-get:*:image/jpeg:*']).join(',');

function srtIndexes(file) {
  return (file.subtitles || []).map(function (sub, index) {
    return /\.srt$/i.test(sub.relPath) ? index : -1;
  }).filter(function (i) { return i !== -1; });
}

function remote(req) {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

/**
 * @param {{ info: function(): object, snapshot: function(): Promise<object>, updateId: function(): number,
 *   seen: function(string, string|null, string): void }} ctx
 * @returns {express.Express & { notifyChange: function(): void, closeSubscriptions: function(): void }}
 */
function create(ctx) {
  var app = express(),
    subscriptions = {},   // sid → { service, callback, expires, seq, address }
    art = new Map(),      // image name → { type, body }
    changeTimer = null;

  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(function (req, res, next) {
    var address = remote(req);
    if (!discovery.isLocalAddress(address)) {
      log.warn('refused a DLNA request from ' + address);
      res.status(403).end();
      return;
    }
    res.setHeader('Server', ctx.info().server);
    ctx.seen(address, req.get('user-agent') || null, /^\/dlna\/media\//.test(req.path) && req.method === 'GET' ? 'played' : 'browsed');
    log.debug(req.method + ' ' + req.path, { from: address });
    next();
  });
  app.use(middleware.hostCheck);

  // Absolute URLs as the renderer reached us (the Host it sent: an address)
  function base(req) {
    return 'http://' + req.headers.host;
  }

  function sendXml(res, body, status) {
    res.status(status || 200).set('Content-Type', 'text/xml; charset="utf-8"').send(body);
  }

  // ── descriptions ─────────────────────────────────────────────────────────

  app.get('/dlna/description.xml', function (req, res) {
    var info = ctx.info();
    sendXml(res, descriptions.device(Object.assign({}, info, {
      dashboard: info.apiPort ? 'http://' + middleware.hostname(req.headers.host) + ':' + info.apiPort + '/' : null
    })));
  });

  app.get('/dlna/:service.xml', function (req, res) {
    var body = descriptions.services[req.params.service];
    if (!body) {
      return res.status(404).end();
    }
    sendXml(res, body);
  });

  // ── control (SOAP) ───────────────────────────────────────────────────────

  function didl(req, objects) {
    var b = base(req);
    return xml.didl(objects.map(function (o) {
      if (o.container) {
        return Object.assign({}, o, { art: o.art ? b + '/dlna/art' + o.art : null });
      }
      var file = o.file, probe = file.probe || {};
      return Object.assign({}, o, {
        art: o.art ? b + '/dlna/art' + o.art : null,
        res: {
          url: b + '/dlna/media/' + file.id + path.extname(file.relPath).toLowerCase(),
          protocolInfo: protocolInfo(mimeOf(file.relPath)),
          size: file.size,
          duration: probe.duration,
          resolution: probe.width && probe.height ? probe.width + 'x' + probe.height : null
        },
        subtitles: srtIndexes(file).map(function (index) {
          return { url: b + '/dlna/subtitles/' + file.id + '/' + index + '.srt', type: 'srt' };
        })
      });
    }));
  }

  function uint(text, fallback) {
    if (text === undefined || text === '') {
      return fallback;
    }
    return /^\d+$/.test(text) ? Number(text) : NaN;
  }

  var ACTIONS = {
    ContentDirectory: {
      type: descriptions.CDS,
      Browse: function (args, req) {
        var flag = args.BrowseFlag,
          start = uint(args.StartingIndex, 0),
          count = uint(args.RequestedCount, 0);
        if ((flag !== 'BrowseMetadata' && flag !== 'BrowseDirectChildren') || !(start >= 0) || !(count >= 0) ||
          args.ObjectID === undefined) {
          return Promise.resolve({ fault: 402 });
        }
        return ctx.snapshot().then(function (snapshot) {
          var found = tree.browse(snapshot, args.ObjectID, flag, start, count);
          if (!found) {
            return { fault: 701 };
          }
          return { out: [
            ['Result', didl(req, found.objects)],
            ['NumberReturned', found.objects.length],
            ['TotalMatches', found.total],
            ['UpdateID', ctx.updateId()]
          ] };
        });
      },
      GetSearchCapabilities: function () { return { out: [['SearchCaps', '']] }; },
      GetSortCapabilities: function () { return { out: [['SortCaps', '']] }; },
      GetSystemUpdateID: function () { return { out: [['Id', ctx.updateId()]] }; },
      // Samsung TVs ask where videos are; the answer is the root
      X_GetFeatureList: function () {
        return { out: [['FeatureList', '<?xml version="1.0" encoding="UTF-8"?><Features xmlns="urn:schemas-upnp-org:av:avs" ' +
          'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:schemas-upnp-org:av:avs ' +
          'http://www.upnp.org/schemas/av/avs.xsd"><Feature name="samsung.com_BASICVIEW" version="1">' +
          '<container id="0" type="object.item.videoItem"/></Feature></Features>']] };
      },
      // Samsung's resume points: accepted, not kept (nothing is written by DLNA)
      X_SetBookmark: function () { return { out: [] }; }
    },
    ConnectionManager: {
      type: descriptions.CMS,
      GetProtocolInfo: function () { return { out: [['Source', SOURCE_PROTOCOLS], ['Sink', '']] }; },
      GetCurrentConnectionIDs: function () { return { out: [['ConnectionIDs', '0']] }; },
      GetCurrentConnectionInfo: function (args) {
        if (args.ConnectionID !== '0') {
          return { fault: 402 };
        }
        return { out: [['RcsID', -1], ['AVTransportID', -1], ['ProtocolInfo', ''], ['PeerConnectionManager', ''],
          ['PeerConnectionID', -1], ['Direction', 'Output'], ['Status', 'OK']] };
      }
    },
    X_MS_MediaReceiverRegistrar: {
      type: descriptions.MRR,
      IsAuthorized: function () { return { out: [['Result', 1]] }; },
      IsValidated: function () { return { out: [['Result', 1]] }; },
      RegisterDevice: function () { return { out: [['RegistrationRespMsg', '']] }; }
    }
  };

  app.post('/dlna/control/:service', express.text({ type: function () { return true; }, limit: '64kb' }), function (req, res) {
    var service = ACTIONS[req.params.service];
    if (!service) {
      return res.status(404).end();
    }
    var call = xml.parseAction(req.get('soapaction'), typeof req.body === 'string' ? req.body : ''),
      handler = call && call.action !== 'type' && service[call.action];
    if (!handler) {
      // Search, CreateObject, DestroyObject, UpdateObject…: nothing changes over DLNA
      log.debug('DLNA action not implemented: ' + (call ? call.action : '(unreadable)'), { from: remote(req) });
      return sendXml(res, xml.fault(401), 500);
    }
    Promise.resolve().then(function () {
      return handler(call.args, req);
    }).then(function (result) {
      if (result.fault) {
        return sendXml(res, xml.fault(result.fault), 500);
      }
      res.setHeader('EXT', '');
      sendXml(res, xml.response(service.type, call.action, result.out));
    }, function (err) {
      log.warn('DLNA ' + call.action + ' failed: ' + err.message);
      sendXml(res, xml.fault(501), 500);
    });
  });

  // ── eventing (GENA) ──────────────────────────────────────────────────────

  function properties(service) {
    if (service === 'ContentDirectory') {
      return [['SystemUpdateID', ctx.updateId()], ['ContainerUpdateIDs', '']];
    }
    if (service === 'ConnectionManager') {
      return [['SourceProtocolInfo', SOURCE_PROTOCOLS], ['SinkProtocolInfo', ''], ['CurrentConnectionIDs', '0']];
    }
    return [['AuthorizationGrantedUpdateID', 0], ['AuthorizationDeniedUpdateID', 0],
      ['ValidationSucceededUpdateID', 0], ['ValidationRevokedUpdateID', 0]];
  }

  function sendEvent(sid, props) {
    var sub = subscriptions[sid];
    if (!sub) {
      return;
    }
    var body = '<?xml version="1.0" encoding="utf-8"?>\n<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">' +
      props.map(function (p) { return '<e:property>' + xml.elements([p]) + '</e:property>'; }).join('') + '</e:propertyset>',
      target = new URL(sub.callback),
      request = http.request({
        method: 'NOTIFY',
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        timeout: 3000,
        headers: {
          HOST: target.host,
          'CONTENT-TYPE': 'text/xml; charset="utf-8"',
          'CONTENT-LENGTH': Buffer.byteLength(body),
          NT: 'upnp:event',
          NTS: 'upnp:propchange',
          SID: sid,
          SEQ: sub.seq
        }
      });
    sub.seq = sub.seq === 4294967295 ? 1 : sub.seq + 1;
    request.on('response', function (r) { r.resume(); });
    request.on('timeout', function () { request.destroy(); });
    request.on('error', function (err) {
      log.debug('DLNA event not delivered: ' + err.message, { to: target.hostname });
    });
    request.end(body);
  }

  function expire() {
    var now = Date.now();
    Object.keys(subscriptions).forEach(function (sid) {
      if (subscriptions[sid].expires < now) {
        delete subscriptions[sid];
      }
    });
  }

  function timeout(header) {
    var m = /^Second-(\d+)$/i.exec(String(header || '').trim());
    return Math.max(300, Math.min(1800, m ? Number(m[1]) : 1800));
  }

  app.subscribe('/dlna/events/:service', function (req, res) {
    var service = req.params.service;
    if (!descriptions.services[service]) {
      return res.status(404).end();
    }
    expire();
    var seconds = timeout(req.get('timeout')), sid = req.get('sid');
    if (sid) {
      // a renewal
      if (!subscriptions[sid] || subscriptions[sid].service !== service || req.get('callback') || req.get('nt')) {
        return res.status(412).end();
      }
      subscriptions[sid].expires = Date.now() + seconds * 1000;
      return res.set({ SID: sid, TIMEOUT: 'Second-' + seconds, 'Content-Length': 0 }).status(200).end();
    }
    var urls = (String(req.get('callback') || '').match(/<([^>]+)>/g) || []).map(function (u) { return u.slice(1, -1); }),
      address = remote(req),
      callback = urls.filter(function (u) {
        try {
          var parsed = new URL(u);
          // only back to the subscriber itself: eventing is no way to make this server call others
          return parsed.protocol === 'http:' && parsed.hostname.replace(/^\[|\]$/g, '') === address;
        } catch (e) {
          return false;
        }
      })[0];
    if (req.get('nt') !== 'upnp:event' || !callback) {
      return res.status(412).end();
    }
    if (Object.keys(subscriptions).length >= MAX_SUBSCRIPTIONS) {
      return res.status(503).end();
    }
    sid = 'uuid:' + crypto.randomUUID();
    subscriptions[sid] = { service: service, callback: callback, expires: Date.now() + seconds * 1000, seq: 0, address: address };
    res.set({ SID: sid, TIMEOUT: 'Second-' + seconds, 'Content-Length': 0 }).status(200).end();
    // the initial event, once the subscriber has its SID
    setTimeout(function () { sendEvent(sid, properties(service)); }, 100).unref();
  });

  app.unsubscribe('/dlna/events/:service', function (req, res) {
    var sid = req.get('sid');
    if (!sid || !subscriptions[sid]) {
      return res.status(412).end();
    }
    delete subscriptions[sid];
    res.status(200).end();
  });

  // The library changed: SystemUpdateID goes to ContentDirectory's
  // subscribers, at most every 2 s (UPnP's moderation of that variable)
  app.notifyChange = function () {
    if (changeTimer) {
      return;
    }
    changeTimer = setTimeout(function () {
      changeTimer = null;
      expire();
      Object.keys(subscriptions).forEach(function (sid) {
        if (subscriptions[sid].service === 'ContentDirectory') {
          sendEvent(sid, [['SystemUpdateID', ctx.updateId()], ['ContainerUpdateIDs', '']]);
        }
      });
    }, EVENT_MODERATION_MS);
    changeTimer.unref();
  };

  app.closeSubscriptions = function () {
    clearTimeout(changeTimer);
    changeTimer = null;
    subscriptions = {};
  };

  // ── media ────────────────────────────────────────────────────────────────

  // The file of a DLNA folder by its id: in the tree, then resolved on disk
  // (realpath inside its folder) with the folder's current rules
  function dlnaFile(id) {
    return ctx.snapshot().then(function (snapshot) {
      var row = snapshot.files[id];
      if (!row) {
        return null;
      }
      return media.resolve(media.refs.file(id)).then(function (found) {
        return found.folder.dlna && found.folder.audience === 'everyone' ? { row: row, media: found } : null;
      }, function () {
        return null;
      });
    });
  }

  var FILE_ID = /^([0-9a-f-]{36})(\.[a-z0-9]{1,5})?$/,
    SUBTITLE_FILE = /^(\d{1,4})\.srt$/,
    ART_NAME = /^[A-Za-z0-9_-]{1,64}\.(jpg|png)$/;

  app.get('/dlna/media/:file', function (req, res) {
    var address = remote(req),
      m = FILE_ID.exec(req.params.file);
    if (!m) {
      return res.status(404).end();
    }
    var id = m[1];
    dlnaFile(id).then(function (found) {
      if (!found) {
        return res.status(404).end();
      }
      var file = found.media,
        size = file.size,
        ranges = req.headers.range ? rangeParser(size, req.headers.range) : null,
        range = Array.isArray(ranges) && ranges.type === 'bytes' ? ranges[0] : null;
      if (ranges === -1) {
        return res.status(416).set('Content-Range', 'bytes */' + size).end();
      }
      res.set({
        'Content-Type': mimeOf(file.path),
        'Accept-Ranges': 'bytes',
        'transferMode.dlna.org': 'Streaming',
        'contentFeatures.dlna.org': FLAGS
      });
      // Samsung asks for the subtitle with the video
      var subs = srtIndexes(found.row);
      if (subs.length && req.get('getcaptioninfo.sec') === '1') {
        res.set('CaptionInfo.sec', base(req) + '/dlna/subtitles/' + id + '/' + subs[0] + '.srt');
      }
      if (range) {
        res.status(206).set({ 'Content-Length': range.end - range.start + 1, 'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + size });
      } else {
        res.status(200).set('Content-Length', size);
      }
      if (req.method === 'HEAD') {
        return res.end();
      }
      // the dashboard's Activity shows the renderer playing it (a lease on the ref)
      var lease = sessions.acquire(file.key, req);
      if (!lease.client) {
        lease.client = 'DLNA' + (req.get('user-agent') ? ' (' + String(req.get('user-agent')).slice(0, 80) + ')' : '');
      }
      sessions.trackStream(lease, req, res, file, 'direct');
      req.socket.setTimeout(3600000);
      return media.open(file, range).then(function (body) {
        if (res.destroyed) {
          return body.destroy();
        }
        pump(body, res);
      });
    }).catch(function (err) {
      log.warn('DLNA stream failed: ' + err.message, { from: address });
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy();
      }
    });
  });

  app.get('/dlna/subtitles/:id/:file', function (req, res) {
    var m = SUBTITLE_FILE.exec(req.params.file);
    if (!/^[0-9a-f-]{36}$/.test(req.params.id) || !m) {
      return res.status(404).end();
    }
    var index = parseInt(m[1], 10);
    dlnaFile(req.params.id).then(function (found) {
      if (!found || srtIndexes(found.row).indexOf(index) === -1) {
        return res.status(404).end();
      }
      return media.sidecar(found.media, index).then(function (sub) {
        res.set({ 'Content-Type': 'text/srt; charset=utf-8', 'transferMode.dlna.org': 'Interactive' }).send(sub.buffer);
      });
    }).catch(function () {
      if (!res.headersSent) {
        res.status(404).end();
      }
    });
  });

  // TMDB images by name only (`/abc123.jpg` of a poster path): no URL from
  // the renderer is ever fetched. Cached in memory (posters are small).
  app.get('/dlna/art/:name', function (req, res) {
    var name = req.params.name, cached = art.get(name);
    if (!ART_NAME.test(name)) {
      return res.status(404).end();
    }
    function send(image) {
      res.set({ 'Content-Type': image.type, 'Cache-Control': 'public, max-age=86400', 'transferMode.dlna.org': 'Interactive' })
        .send(image.body);
    }
    if (cached) {
      return send(cached);
    }
    axios.get('https://image.tmdb.org/t/p/' + ART_SIZE + '/' + name, { responseType: 'arraybuffer', timeout: 10000, maxContentLength: 2 * 1024 * 1024 })
      .then(function (r) {
        var image = { type: /png$/.test(name) ? 'image/png' : 'image/jpeg', body: Buffer.from(r.data) };
        art.set(name, image);
        if (art.size > ART_CACHE) {
          art.delete(art.keys().next().value);
        }
        send(image);
      }, function () {
        res.status(404).end();
      });
  });

  app.use(function (req, res) {
    res.status(404).end();
  });
  // eslint-disable-next-line no-unused-vars
  app.use(function (err, req, res, next) {
    log.warn('DLNA request failed: ' + err.message);
    if (!res.headersSent) {
      res.status(err.status || 500).end();
    }
  });

  return app;
}

module.exports = {
  create: create,
  mimeOf: mimeOf,
  FLAGS: FLAGS
};
