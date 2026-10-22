'use strict';

// Runs a sidecar engine (rqbit, playpex-torrentd: docs/media-server-plan.md
// §4.6, decision J) and talks to its HTTP API on loopback.
//
//   var s = new Supervisor({
//     name, bin, version, log,
//     peerPort,                       // kept across restarts once chosen
//     args(apiPort, peerPort) → [],   // its command line
//     env(secret) → {},               // the secret (a random one at each start) goes by environment
//     auth(secret) → 'Basic …' | 'Bearer …',
//     readyPath                       // GET it until 200
//   })
//   s.start() → Promise (it answers)     s.stop() → Promise
//   s.request(method, path, { query, body, headers, timeoutMs, stream, signal }) → Promise<{ status, json, raw } | IncomingMessage>
//   s.on('restarted') (after a crash), s.on('failed', err) (gave up), s.status()
//
// Its API listens on 127.0.0.1:<a free port>. A crash restarts it after 1 s,
// 5 s, then 30 s; 5 crashes in 10 minutes and it stays down (status().failed)
// until the server restarts. The server dying kills it (process 'exit').

var http = require('http'),
  net = require('net'),
  crypto = require('crypto'),
  events = require('events'),
  util = require('util'),
  spawn = require('child_process').spawn,
  errors = require('../errors');

var EngineError = errors.EngineError,
  READY_MS = 20000,
  STOP_MS = 5000,
  BACKOFF_MS = [1000, 5000, 30000],
  CRASH_WINDOW_MS = 10 * 60 * 1000,
  MAX_CRASHES = 5;

function freePort(port, host) {
  return new Promise(function (resolve) {
    function attempt(p) {
      var s = net.createServer();
      s.on('error', function () { attempt(0); });
      s.listen(p, host, function () {
        var found = s.address().port;
        s.close(function () { resolve(found); });
      });
    }
    attempt(port);
  });
}

function Supervisor(options) {
  events.EventEmitter.call(this);
  this.options = options;
  this.log = options.log;
  this.child = null;
  this.apiPort = null;
  this.peerPort = null;
  this.password = null;
  this.agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
  this.ready = null;       // Promise while (re)starting, then resolved
  this.stopping = false;
  this.crashes = [];
  this.failed = null;
}
util.inherits(Supervisor, events.EventEmitter);

Supervisor.prototype.spawn = function () {
  var self = this, o = this.options;
  this.password = crypto.randomBytes(24).toString('hex');
  var child = this.child = spawn(o.bin, o.args(this.apiPort, this.peerPort), {
    env: Object.assign({}, process.env, o.env(this.password)),
    // stdin stays open: a sidecar may stop when it closes (the server died)
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  function lines(stream) {
    var rest = '';
    stream.on('data', function (chunk) {
      var all = (rest + chunk).split(/\r?\n/);
      rest = all.pop();
      all.forEach(function (line) {
        line = line.replace(/\x1b\[[0-9;]*m/g, '').trim();   // jshint ignore:line
        if (line) {
          // shutting down, a sidecar reports its own cancellation: not news
          var loud = / (WARN|ERROR) /.test(line) && !self.stopping;
          (loud ? self.log.warn : self.log.debug).call(self.log, o.name + ': ' + line.replace(/^\S+Z\s+/, ''));
        }
      });
    });
  }
  lines(child.stdout);
  lines(child.stderr);
  // the server going down hard must not leave the sidecar running
  var onExit = function () {
    try {
      child.kill('SIGKILL');
    } catch (e) {
      // gone already
    }
  };
  process.once('exit', onExit);
  child.once('exit', function () { process.removeListener('exit', onExit); });
  child.on('error', function (err) {
    self.log.error(o.name + ' could not run: ' + err.message);
  });
  child.on('exit', function (code, signal) {
    if (self.child === child) {
      self.child = null;
    }
    if (self.stopping) {
      return;
    }
    self.log.warn(o.name + ' exited (' + (signal || 'code ' + code) + ')');
    self.crashed();
  });
  return child;
};

// Polls its API until it answers (or the process is gone)
Supervisor.prototype.waitReady = function (child) {
  var self = this, deadline = Date.now() + READY_MS;
  return new Promise(function (resolve, reject) {
    function attempt() {
      if (self.child !== child) {
        return reject(new Error(self.options.name + ' exited while starting'));
      }
      self.send('GET', self.options.readyPath || '/', {}, 2000).then(function (res) {
        if (res.status === 200) {
          return resolve();
        }
        throw new Error('HTTP ' + res.status);
      }).catch(function (err) {
        if (Date.now() > deadline) {
          return reject(new Error(self.options.name + ' did not answer within ' + READY_MS / 1000 + ' s: ' + err.message));
        }
        setTimeout(attempt, 100);
      });
    }
    attempt();
  });
};

Supervisor.prototype.launch = function () {
  var self = this, o = this.options;
  this.ready = Promise.all([freePort(0, '127.0.0.1'), this.peerPort ? this.peerPort : freePort(o.peerPort || 0)]).then(function (ports) {
    self.apiPort = ports[0];
    self.peerPort = ports[1];
    var child = self.spawn();
    return self.waitReady(child).then(function () {
      self.log.info(o.name + ' ' + (o.version || '') + ' running (pid ' + child.pid + '), API on 127.0.0.1:' + self.apiPort +
        ', peer port ' + self.peerPort);
    }, function (err) {
      if (self.child === child) {
        child.kill('SIGKILL');
      }
      throw err;
    });
  });
  return this.ready;
};

Supervisor.prototype.start = function () {
  this.stopping = false;
  this.failed = null;
  return this.launch();
};

Supervisor.prototype.crashed = function () {
  var self = this, now = Date.now();
  this.crashes = this.crashes.filter(function (t) { return now - t < CRASH_WINDOW_MS; }).concat(now);
  if (this.crashes.length >= MAX_CRASHES) {
    this.failed = new Error(this.options.name + ' crashed ' + this.crashes.length + ' times in 10 minutes; restart the server');
    this.log.error(this.failed.message);
    this.ready = Promise.reject(this.failed);
    this.ready.catch(function () {});
    this.emit('failed', this.failed);
    return;
  }
  var delay = BACKOFF_MS[Math.min(this.crashes.length - 1, BACKOFF_MS.length - 1)];
  this.log.info('restarting ' + this.options.name + ' in ' + delay / 1000 + ' s');
  var restarted = new Promise(function (resolve) { setTimeout(resolve, delay); }).then(function () {
    if (self.stopping) {
      throw new Error('stopped');
    }
    return self.launch();
  });
  this.ready = restarted;
  restarted.then(function () {
    self.emit('restarted');
  }, function (err) {
    if (!self.stopping) {
      self.log.warn(self.options.name + ' restart failed: ' + err.message);
      if (!self.child) {
        self.crashed();
      }
    }
  });
};

Supervisor.prototype.stop = function () {
  var self = this, child = this.child;
  this.stopping = true;
  this.agent.destroy();
  if (!child) {
    return Promise.resolve();
  }
  return new Promise(function (resolve) {
    var timer = setTimeout(function () { child.kill('SIGKILL'); }, STOP_MS);
    child.once('exit', function () {
      clearTimeout(timer);
      self.log.info(self.options.name + ' stopped');
      resolve();
    });
    child.kill('SIGTERM');
  });
};

Supervisor.prototype.status = function () {
  return { running: !!this.child, pid: this.child ? this.child.pid : null, apiPort: this.apiPort, peerPort: this.peerPort,
    failed: this.failed ? this.failed.message : null };
};

// One HTTP request to the sidecar, now (no waiting for a restart)
Supervisor.prototype.send = function (method, urlPath, options, timeoutMs) {
  var self = this;
  options = options || {};
  var query = options.query ? '?' + Object.keys(options.query).filter(function (k) {
      return options.query[k] !== undefined && options.query[k] !== null;
    }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(options.query[k]); }).join('&') : '',
    body = options.body === undefined ? null : Buffer.isBuffer(options.body) ? options.body :
      typeof options.body === 'string' ? Buffer.from(options.body) : Buffer.from(JSON.stringify(options.body)),
    headers = Object.assign({
      Authorization: this.options.auth(this.password)
    }, body && typeof options.body === 'object' && !Buffer.isBuffer(options.body) ? { 'Content-Type': 'application/json' } : {},
      body ? { 'Content-Length': body.length } : {}, options.headers);
  return new Promise(function (resolve, reject) {
    var req = http.request({
      host: '127.0.0.1', port: self.apiPort, method: method, path: urlPath + (query === '?' ? '' : query),
      headers: headers, agent: options.stream ? false : self.agent
    }, function (res) {
      if (options.stream && res.statusCode < 300) {
        return resolve(res);
      }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks), json = null;
        if (/json/.test(res.headers['content-type'] || '')) {
          try {
            json = JSON.parse(raw.toString('utf8'));
          } catch (e) {
            json = null;
          }
        }
        resolve({ status: res.statusCode, json: json, raw: raw, headers: res.headers });
      });
      res.on('error', reject);
    });
    if (timeoutMs) {
      req.setTimeout(timeoutMs, function () { req.destroy(new Error(self.options.name + ' did not answer in time')); });
    }
    if (options.signal) {
      if (options.signal.aborted) {
        return req.destroy(new Error('aborted'));
      }
      options.signal.addEventListener('abort', function () { req.destroy(new Error('aborted')); });
    }
    req.on('error', reject);
    req.end(body);
  });
};

/**
 * A request to the sidecar's API, once it runs (waits for a restart). Network
 * failures → EngineError UNAVAILABLE.
 * @param {string} method
 * @param {string} urlPath
 * @param {{ query?: object, body?: *, headers?: object, timeoutMs?: number, stream?: boolean, signal?: AbortSignal }} [options]
 */
Supervisor.prototype.request = function (method, urlPath, options) {
  var self = this;
  options = options || {};
  if (!this.ready) {
    return Promise.reject(EngineError('UNAVAILABLE', this.options.name + ' is not started'));
  }
  return this.ready.then(function () {
    return self.send(method, urlPath, options, options.timeoutMs === undefined ? 30000 : options.timeoutMs);
  }, function (err) {
    throw EngineError('UNAVAILABLE', self.options.name + ' is not running: ' + err.message, err);
  }).catch(function (err) {
    if (errors.isEngineError(err)) {
      throw err;
    }
    throw EngineError('UNAVAILABLE', self.options.name + ': ' + err.message, err);
  });
};

module.exports = Supervisor;
