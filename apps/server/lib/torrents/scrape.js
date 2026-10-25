'use strict';

// Tracker scrapes (docs/dashboard-plan.md §4.4): how many seeds and leechers
// a tracker counts for torrents, whatever the engine: HTTP (BEP 48, the
// announce URL's "announce" → "scrape") and UDP (BEP 15). Several info hashes
// per request; never more than the timeout.
//
//   scrape(announceUrl, [infoHash…], { timeoutMs? })
//     → Promise<{ <infoHash>: { seeds, peers, downloaded } }>   (rejects: why, in words)

var http = require('http'),
  https = require('https'),
  dgram = require('dgram'),
  crypto = require('crypto'),
  dns = require('dns');

var TIMEOUT_MS = 10000,
  MAX_BODY = 1024 * 1024,
  UDP_HASHES = 74;      // what fits one UDP scrape (BEP 15)

function failure(message) {
  return new Error(message);
}

// ── bencode (enough for a scrape answer: dictionary keys as latin1, so the
// binary info hashes it is keyed by survive) ─────────────────────────────────

function bdecode(buf) {
  var pos = 0;
  function next() {
    var c = buf[pos];
    if (c === 0x64) {          // d
      pos++;
      var dict = {};
      while (buf[pos] !== 0x65) {
        var key = string().toString('latin1');
        dict[key] = next();
      }
      pos++;
      return dict;
    }
    if (c === 0x6c) {          // l
      pos++;
      var list = [];
      while (buf[pos] !== 0x65) {
        list.push(next());
      }
      pos++;
      return list;
    }
    if (c === 0x69) {          // i
      var end = buf.indexOf(0x65, pos);
      var n = Number(buf.toString('ascii', pos + 1, end));
      pos = end + 1;
      return n;
    }
    return string();
  }
  function string() {
    var colon = buf.indexOf(0x3a, pos);
    if (colon === -1) {
      throw failure('not bencode');
    }
    var len = Number(buf.toString('ascii', pos, colon));
    if (!(len >= 0) || colon + 1 + len > buf.length) {
      throw failure('not bencode');
    }
    pos = colon + 1 + len;
    return buf.slice(colon + 1, pos);
  }
  return next();
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function scrapeUrl(announce) {
  var u = new URL(announce), parts = u.pathname.split('/'), last = parts[parts.length - 1];
  if (last.indexOf('announce') !== 0) {
    return null;      // BEP 48: this tracker has no scrape
  }
  parts[parts.length - 1] = 'scrape' + last.slice('announce'.length);
  u.pathname = parts.join('/');
  return u;
}

function viaHttp(announce, hashes, timeoutMs) {
  var u = scrapeUrl(announce);
  if (!u) {
    return Promise.reject(failure('This tracker has no scrape'));
  }
  var query = hashes.map(function (h) {
    return 'info_hash=' + Buffer.from(h, 'hex').toString('latin1').split('').map(function (ch) {
      var code = ch.charCodeAt(0);
      return /[A-Za-z0-9.\-_~]/.test(ch) ? ch : '%' + (code < 16 ? '0' : '') + code.toString(16).toUpperCase();
    }).join('');
  }).join('&');
  var href = u.toString() + (u.search ? '&' : '?') + query;
  return new Promise(function (resolve, reject) {
    var req = (u.protocol === 'https:' ? https : http).get(href, { timeout: timeoutMs, headers: { 'User-Agent': 'Playpex' } }, function (res) {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(failure('The tracker answered HTTP ' + res.statusCode));
      }
      var chunks = [], size = 0;
      res.on('data', function (c) {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy(failure('The tracker\'s answer is too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', function () {
        try {
          var answer = bdecode(Buffer.concat(chunks));
          if (answer['failure reason']) {
            return reject(failure(answer['failure reason'].toString()));
          }
          var out = {}, files = answer.files || {}, keys = Object.keys(files);
          keys.forEach(function (key) {
            var f = files[key], hash = hashOf(key);
            // one asked, one answered: that one, whatever its key looks like
            if (hashes.indexOf(hash) === -1 && hashes.length === 1 && keys.length === 1) {
              hash = hashes[0];
            }
            if (hashes.indexOf(hash) !== -1) {
              out[hash] = { seeds: num(f.complete), peers: num(f.incomplete), downloaded: num(f.downloaded) };
            }
          });
          resolve(out);
        } catch (e) {
          reject(failure('The tracker\'s answer is not readable'));
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', function () { req.destroy(failure('The tracker did not answer')); });
    req.on('error', function (err) { reject(failure(err.message)); });
  });
}

// A scrape's key → the info hash in hex: the 20 bytes themselves (the
// standard), their UTF-8 re-encoding (some Node trackers), or hex
function hashOf(key) {
  if (key.length === 20) {
    return Buffer.from(key, 'latin1').toString('hex');
  }
  if (/^[0-9a-f]{40}$/i.test(key)) {
    return key.toLowerCase();
  }
  var raw = Buffer.from(Buffer.from(key, 'latin1').toString('utf8'), 'latin1');
  return raw.length === 20 ? raw.toString('hex') : null;
}

function num(v) {
  return typeof v === 'number' && v >= 0 ? v : null;
}

// ── UDP ─────────────────────────────────────────────────────────────────────

var CONNECT_ID = Buffer.from('0000041727101980', 'hex');

function viaUdp(announce, hashes, timeoutMs) {
  var u = new URL(announce), port = Number(u.port);
  if (!port) {
    return Promise.reject(failure('No port in this tracker\'s address'));
  }
  return new Promise(function (resolve, reject) {
    dns.lookup(u.hostname, { family: 4 }, function (err, address) {
      if (err) {
        return reject(failure('Cannot find ' + u.hostname));
      }
      var socket = dgram.createSocket('udp4'), done = false, tx = crypto.randomBytes(4), out = {};
      var timer = setTimeout(function () { finish(failure('The tracker did not answer')); }, timeoutMs);
      function finish(error) {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        try { socket.close(); } catch (e) { /* closed */ }
        return error ? reject(error) : resolve(out);
      }
      function send(buf) {
        socket.send(buf, 0, buf.length, port, address, function (e) {
          if (e) {
            finish(failure(e.message));
          }
        });
      }
      socket.on('error', function (e) { finish(failure(e.message)); });
      socket.on('message', function (msg) {
        if (msg.length < 8 || !msg.slice(4, 8).equals(tx)) {
          return;
        }
        var action = msg.readUInt32BE(0);
        if (action === 3) {
          return finish(failure(msg.slice(8).toString() || 'The tracker refused'));
        }
        if (action === 0 && msg.length >= 16) {
          tx = crypto.randomBytes(4);
          var head = Buffer.alloc(16);
          msg.copy(head, 0, 8, 16);     // its connection id
          head.writeUInt32BE(2, 8);     // scrape
          tx.copy(head, 12);
          return send(Buffer.concat([head].concat(hashes.map(function (h) { return Buffer.from(h, 'hex'); }))));
        }
        if (action === 2) {
          hashes.forEach(function (h, i) {
            var at = 8 + i * 12;
            if (msg.length >= at + 12) {
              out[h] = { seeds: msg.readUInt32BE(at), downloaded: msg.readUInt32BE(at + 4), peers: msg.readUInt32BE(at + 8) };
            }
          });
          finish(null);
        }
      });
      var connect = Buffer.alloc(16);
      CONNECT_ID.copy(connect, 0);
      connect.writeUInt32BE(0, 8);
      tx.copy(connect, 12);
      send(connect);
    });
  });
}

/**
 * @param {string} announce   an http(s):// or udp:// announce URL
 * @param {string[]} hashes   info hashes (hex)
 * @param {{ timeoutMs?: number }} [options]
 */
function scrape(announce, hashes, options) {
  var timeoutMs = (options && options.timeoutMs) || TIMEOUT_MS;
  return Promise.resolve().then(function () {
    var scheme = new URL(announce).protocol;
    if (scheme === 'udp:') {
      var batches = [];
      for (var i = 0; i < hashes.length; i += UDP_HASHES) {
        batches.push(hashes.slice(i, i + UDP_HASHES));
      }
      return Promise.all(batches.map(function (b) { return viaUdp(announce, b, timeoutMs); })).then(function (all) {
        return Object.assign.apply(Object, [{}].concat(all));
      });
    }
    if (scheme === 'http:' || scheme === 'https:') {
      return viaHttp(announce, hashes, timeoutMs);
    }
    throw failure('Trackers at ' + scheme + ' aren\'t scraped');
  });
}

module.exports = { scrape: scrape, scrapeUrl: scrapeUrl };
