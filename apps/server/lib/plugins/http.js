'use strict';

// playpex.http.request for plugins (docs/plugins-plan.md §4.2): HTTPS to the
// hosts a plugin declared, and only to public addresses (SSRF: the server
// sits on the LAN). The name is resolved by us, every address checked, and
// the connection made to the checked address (no second lookup a DNS
// rebinding could change); every redirect is checked again. Port 443 only,
// 10 s per request, 8 MB answers (after decompression), no cookie jar, and
// a rate limit per plugin and host (./ratelimit.js).
//
//   request(plugin, options) → Promise<{ value: { status, headers, url, body }, bytes? }>
//     plugin: { id, permissions }; options: { url, method?, headers?, body?, responseType?: text|json|bytes }
//   stream(plugin, { url, headers, method, range }) → Promise<{ status, headers, body, url, abort }>
//     an http source's bytes (./remote.js): same checks, no size cap or decompression
//   configure({ lookup, ports, ca, allowAddresses, maxWaitMs })   tests only: a fake resolver, other ports, a CA,
//     addresses to treat as public (a loopback test server), a shorter wait for the rate limit

var https = require('https'),
  dns = require('dns'),
  net = require('net'),
  zlib = require('zlib'),
  protocol = require('@playpex/protocol/plugins'),
  RateLimiter = require('./ratelimit');

var LIMITS = protocol.LIMITS.http,
  METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  REDIRECTS = [301, 302, 303, 307, 308],
  // request headers that are ours (forbidden for http sources too), or would lie about the body
  DROPPED = ['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-authorization',
    'te', 'trailer', 'expect', 'accept-encoding'],
  BODY_MAX = 4 * 1024 * 1024,
  USER_AGENT = 'Playpex-Plugin/1 (+https://github.com/IhebBelhadj/Playpex)';

var testing = { lookup: null, ports: [], ca: null, allowAddresses: [], maxWaitMs: null };

// Ranges a plugin may never reach (IANA special-purpose registries)
var blocked = new net.BlockList();
[['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(function (r) { blocked.addSubnet(r[0], r[1], 'ipv4'); });
[['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
].forEach(function (r) { blocked.addSubnet(r[0], r[1], 'ipv6'); });

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

/** Whether a plugin may connect to this address */
function isPublic(address) {
  if (testing.allowAddresses.indexOf(address) !== -1) {
    return true;
  }
  var family = net.isIP(address);
  if (!family) {
    return false;
  }
  if (family === 6) {
    var mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address) || /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) {
      return isPublic(mapped[1]);   // an IPv4 address in IPv6 clothing is judged as itself
    }
    return !blocked.check(address, 'ipv6');
  }
  return !blocked.check(address, 'ipv4');
}

/** Resolves a host name to one checked address (all of its addresses must be public) */
function resolve(host) {
  if (net.isIP(host)) {
    return Promise.reject(failure('ADDRESS_NOT_ALLOWED', 'IP addresses aren\'t allowed: declare a host name'));
  }
  return new Promise(function (ok, fail) {
    (testing.lookup || dns.lookup)(host, { all: true, verbatim: true }, function (err, addresses) {
      if (err) {
        return fail(failure('DNS_FAILED', host + ': ' + (err.code || err.message)));
      }
      addresses = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (!addresses.length) {
        return fail(failure('DNS_FAILED', host + ': no address'));
      }
      var bad = addresses.filter(function (a) { return !isPublic(a.address); });
      if (bad.length) {
        return fail(failure('ADDRESS_NOT_ALLOWED', host + ' resolves to an address plugins can\'t reach (' + bad[0].address + ')'));
      }
      ok(addresses[0]);
    });
  });
}

/** The URL checked against the plugin's permissions; throws */
function target(plugin, url) {
  var u;
  try {
    u = new URL(url);
  } catch (e) {
    throw failure('INVALID', 'not a URL: ' + String(url).slice(0, 200));
  }
  if (u.protocol !== 'https:') {
    throw failure('HTTPS_ONLY', 'only https:// URLs');
  }
  if (u.username || u.password) {
    throw failure('INVALID', 'no credentials in URLs: send a header');
  }
  var port = u.port ? parseInt(u.port, 10) : 443;
  if (port !== 443 && testing.ports.indexOf(port) === -1) {
    throw failure('PORT_NOT_ALLOWED', 'only port 443');
  }
  var host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!protocol.hostAllowed((plugin.permissions && plugin.permissions.network) || [], host)) {
    throw failure('HOST_NOT_ALLOWED', host + ' isn\'t in permissions.network');
  }
  return { url: u, host: host, port: port };
}

function headersOf(given) {
  var out = {};
  if (given && typeof given === 'object') {
    Object.keys(given).slice(0, 50).forEach(function (name) {
      var key = String(name).toLowerCase();
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(key) || DROPPED.indexOf(key) !== -1) {
        return;
      }
      var value = String(given[name]);
      if (!/[\r\n\0]/.test(value) && value.length <= 8192) {
        out[key] = value;
      }
    });
  }
  out['user-agent'] = out['user-agent'] || USER_AGENT;
  out['accept-encoding'] = 'gzip, deflate, br';
  return out;
}

function bodyOf(options, bytes, headers) {
  if (options.body == null) {
    return null;
  }
  var body;
  if (options.body === '$bytes' && bytes) {
    body = bytes;
  } else if (typeof options.body === 'string') {
    body = Buffer.from(options.body);
  } else {
    body = Buffer.from(JSON.stringify(options.body));
    headers['content-type'] = headers['content-type'] || 'application/json';
  }
  if (body.length > BODY_MAX) {
    throw failure('INVALID', 'a request body is at most 4 MB');
  }
  return body;
}

/**
 * One HTTPS request to a checked address; resolves { req, res } when the
 * answer's headers arrive (within the time limit)
 */
function connect(t, address, method, headers, body) {
  return new Promise(function (ok, fail) {
    var done = false;
    var req = https.request({
      host: t.host,
      servername: t.host,
      port: t.port,
      method: method,
      path: t.url.pathname + t.url.search,
      headers: Object.assign({ host: t.url.host }, headers),
      agent: false,
      ca: testing.ca || undefined,
      // the address we checked, not a second lookup
      lookup: function (hostname, opts, callback) {
        if (opts && opts.all) {
          callback(null, [{ address: address.address, family: address.family }]);
        } else {
          callback(null, address.address, address.family);
        }
      }
    }, function (res) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        ok({ req: req, res: res });
      }
    });
    var timer = setTimeout(function () {
      req.destroy();
      if (!done) {
        done = true;
        fail(failure('TIMEOUT', 'no answer in ' + LIMITS.timeoutMs / 1000 + ' s'));
      }
    }, LIMITS.timeoutMs);
    req.on('error', function (err) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        fail(failure('NETWORK', (err.code ? err.code + ': ' : '') + err.message));
      }
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/** One HTTPS exchange to a checked address; resolves { status, headers, buffer } */
function exchange(t, address, method, headers, body) {
  var started = Date.now();
  return connect(t, address, method, headers, body).then(function (r) {
    var req = r.req, res = r.res;
    return new Promise(function (ok, fail) {
      var done = false;
      function finish(err, value) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          if (err) {
            fail(err);
          } else {
            ok(value);
          }
        }
      }
      var timer = setTimeout(function () {
        req.destroy();
        finish(failure('TIMEOUT', 'no answer in ' + LIMITS.timeoutMs / 1000 + ' s'));
      }, Math.max(0, LIMITS.timeoutMs - (Date.now() - started)));
      var encoding = String(res.headers['content-encoding'] || '').toLowerCase(),
        stream = res,
        chunks = [],
        size = 0;
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      } else if (encoding === 'br') {
        stream = res.pipe(zlib.createBrotliDecompress());
      }
      var declared = parseInt(res.headers['content-length'], 10);
      if (!encoding && declared > LIMITS.maxResponseBytes) {
        req.destroy();
        return finish(failure('RESPONSE_TOO_LARGE', 'the answer is larger than 8 MB'));
      }
      stream.on('data', function (chunk) {
        size += chunk.length;
        if (size > LIMITS.maxResponseBytes) {
          req.destroy();
          finish(failure('RESPONSE_TOO_LARGE', 'the answer is larger than 8 MB'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', function () {
        finish(null, { status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) });
      });
      stream.on('error', function (err) {
        finish(failure('NETWORK', err.message));
      });
      res.on('aborted', function () {
        finish(failure('NETWORK', 'the answer was cut'));
      });
    });
  });
}

function responseHeaders(headers) {
  var out = {};
  Object.keys(headers).forEach(function (k) {
    if (k !== 'set-cookie') {
      out[k] = Array.isArray(headers[k]) ? headers[k].join(', ') : String(headers[k]);
    }
  });
  if (headers['set-cookie']) {
    out['set-cookie'] = [].concat(headers['set-cookie']).join('\n');   // a plugin keeps its own cookies (no jar)
  }
  return out;
}

var limiter = new RateLimiter();

/**
 * @param {{ id: string, permissions: object }} plugin
 * @param {object} options from the sandbox ({ url, method, headers, body, responseType })
 * @param {Buffer|null} bytes the body, when the plugin sent bytes
 */
function request(plugin, options, bytes) {
  options = options || {};
  var method = String(options.method || 'GET').toUpperCase(),
    responseType = options.responseType || 'text',
    headers, body, first;
  try {
    if (METHODS.indexOf(method) === -1) {
      throw failure('INVALID', 'method must be one of ' + METHODS.join(', '));
    }
    if (['text', 'json', 'bytes'].indexOf(responseType) === -1) {
      throw failure('INVALID', 'responseType must be text, json or bytes');
    }
    first = target(plugin, options.url);
    headers = headersOf(options.headers);
    body = bodyOf(options, bytes, headers);
  } catch (err) {
    return Promise.reject(err);
  }
  var rules = Object.assign({}, LIMITS, plugin.permissions.rateLimit || {}, testing.maxWaitMs ? { maxWaitMs: testing.maxWaitMs } : {}),
    redirects = 0;

  function hop(t, hopMethod, hopBody, hopHeaders) {
    var release;
    return limiter.acquire(plugin.id + ' ' + t.host, rules).then(function (r) {
      release = r;
      return resolve(t.host);
    }).then(function (address) {
      return exchange(t, address, hopMethod, hopHeaders, hopBody);
    }).then(function (res) {
      release();
      if (REDIRECTS.indexOf(res.status) !== -1 && res.headers.location) {
        if (++redirects > LIMITS.maxRedirects) {
          throw failure('TOO_MANY_REDIRECTS', 'more than ' + LIMITS.maxRedirects + ' redirects');
        }
        var next = redirected(plugin, t, res.headers.location, hopHeaders),
          keep = res.status === 307 || res.status === 308;
        return hop(next.t, keep ? hopMethod : (hopMethod === 'HEAD' ? 'HEAD' : 'GET'), keep ? hopBody : null, next.headers);
      }
      return { response: res, url: t.url.toString() };
    }, function (err) {
      if (release) {
        release();
      }
      throw err;
    });
  }

  return hop(first, method, body, headers).then(function (r) {
    var res = r.response,
      value = { status: res.status, headers: responseHeaders(res.headers), url: r.url };
    if (responseType === 'bytes') {
      value.body = '$bytes';
      return { value: value, bytes: res.buffer };
    }
    var text = res.buffer.toString('utf8');
    if (responseType === 'json') {
      try {
        value.body = text ? JSON.parse(text) : null;
      } catch (e) {
        throw failure('BAD_JSON', 'the answer isn\'t JSON (HTTP ' + res.status + ')');
      }
    } else {
      value.body = text;
    }
    return { value: value };
  });
}

/** The next hop of a redirect, checked again; Authorization and Cookie stay with their host */
function redirected(plugin, t, location, headers) {
  var next = target(plugin, new URL(location, t.url).toString()),
    nextHeaders = Object.assign({}, headers);
  if (next.host !== t.host) {
    delete nextHeaders.authorization;
    delete nextHeaders.cookie;
  }
  return { t: next, headers: nextHeaders };
}

// What the server sends itself on a media stream
var FORBIDDEN = protocol.FORBIDDEN_HEADERS.map(function (h) { return h.toLowerCase(); });

/**
 * A plugin's http source as a media stream (./remote.js, GET /media/r_…):
 * GET (or HEAD) with the source's headers and the viewer's range, checked
 * like request() on every hop, but not decompressed, not size-capped and not
 * rate-limited (the viewer's requests, not the plugin's); the answer's
 * headers within 10 s, then a minute of silence at most.
 *   options: { url, headers?, method?: GET|HEAD, range?: { start, end? } }
 * Resolves { status, headers, body: Readable (the answer), url, abort() }.
 */
function stream(plugin, options) {
  options = options || {};
  var first, headers, redirects = 0;
  try {
    first = target(plugin, options.url);
    headers = headersOf(options.headers);
  } catch (err) {
    return Promise.reject(err);
  }
  FORBIDDEN.forEach(function (h) {
    if (h !== 'host') {
      delete headers[h];
    }
  });
  headers['accept-encoding'] = 'identity';
  if (options.range) {
    headers.range = 'bytes=' + options.range.start + '-' + (options.range.end == null ? '' : options.range.end);
  }
  var method = options.method === 'HEAD' ? 'HEAD' : 'GET';

  function hop(t, hopHeaders) {
    return resolve(t.host).then(function (address) {
      return connect(t, address, method, hopHeaders, null);
    }).then(function (r) {
      var res = r.res;
      if (REDIRECTS.indexOf(res.statusCode) !== -1 && res.headers.location) {
        r.req.destroy();
        if (++redirects > LIMITS.maxRedirects) {
          throw failure('TOO_MANY_REDIRECTS', 'more than ' + LIMITS.maxRedirects + ' redirects');
        }
        var next = redirected(plugin, t, res.headers.location, hopHeaders);
        return hop(next.t, next.headers);
      }
      r.req.setTimeout(60000, function () {
        r.req.destroy(failure('TIMEOUT', 'the source stopped sending'));
      });
      return {
        status: res.statusCode,
        headers: res.headers,
        body: res,
        url: t.url.toString(),
        abort: function () { r.req.destroy(); }
      };
    });
  }
  return hop(first, headers);
}

function configure(options) {
  testing = Object.assign({ lookup: null, ports: [], ca: null, allowAddresses: [], maxWaitMs: null }, options || {});
  limiter.reset();
}

module.exports = {
  request: request,
  stream: stream,
  target: target,
  isPublic: isPublic,
  configure: configure
};
