'use strict';

// The server's side of one plugin's sandbox (./worker.js runs it): starts the
// worker, sends handler calls (at most LIMITS.concurrentCalls at once, each
// with a wall-clock timeout), answers the plugin's host calls through
// `host(api, args, bytes, callId)` (./host.js, which checks the permissions),
// and gives up on a plugin that keeps failing (docs/plugins-plan.md §4.1):
//
//   sandbox = new Sandbox({ id, code, permissions, limits, host, onFailed })
//   sandbox.start() → Promise<{ hook: [], data: [], event: [], job: [] }>   what it registered
//   sandbox.call(kind, name, args, ctx, { timeoutMs }) → Promise<value>       rejects with { code, message }
//   sandbox.stop()
//
// Failures that count (CPU_LIMIT, OUT_OF_MEMORY, STACK_OVERFLOW, TIMEOUT): 3
// within 10 minutes, or the worker dying, and the sandbox is stopped for good
// (onFailed(reason)); the plugin's state becomes `failed`.

var path = require('path'),
  workerThreads = require('worker_threads');

var WORKER = path.join(__dirname, 'worker.js'),
  LOAD_TIMEOUT_MS = 10000,
  STRIKES = 3,
  STRIKE_WINDOW_MS = 10 * 60 * 1000,
  COUNTED = ['CPU_LIMIT', 'OUT_OF_MEMORY', 'STACK_OVERFLOW', 'TIMEOUT'];

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function Sandbox(options) {
  this.id = options.id;
  this.options = options;
  this.worker = null;
  this.calls = new Map();     // callId → { resolve, reject, timer }
  this.queue = [];            // calls waiting for a slot
  this.running = 0;
  this.nextCallId = 1;
  this.strikes = [];
  this.failed = null;
  this.stats = { calls: 0, errors: 0, timeouts: 0, cpuMs: 0 };
}

Sandbox.prototype.start = function () {
  var self = this, o = this.options;
  return new Promise(function (resolve, reject) {
    var worker = new workerThreads.Worker(WORKER, {
      // the Node side of the worker is ours; this only bounds our own heap there
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      stdout: true,
      stderr: true
    });
    var timer = setTimeout(function () {
      settle(failure('LOAD_TIMEOUT', 'the plugin didn\'t finish loading in ' + LOAD_TIMEOUT_MS / 1000 + ' s'));
    }, LOAD_TIMEOUT_MS);
    var loading = true;

    function settle(err, registered) {
      if (!loading) {
        return;
      }
      loading = false;
      clearTimeout(timer);
      if (err) {
        self.stop();
        reject(err);
      } else {
        resolve(registered);
      }
    }

    self.worker = worker;
    worker.on('message', function (message) {
      switch (message.type) {
        case 'ready':
          settle(null, message.registered);
          break;
        case 'fatal':
          if (loading) {
            settle(failure(message.error.code, message.error.message));
          } else {
            self.fail(message.error.code + ': ' + message.error.message);
          }
          break;
        case 'host':
          self.onHost(message);
          break;
        case 'result':
          self.onResult(message);
          break;
        case 'log':
          o.onLog && o.onLog(message.level, message.message, message.fields ? safeJson(message.fields) : undefined);
          break;
        case 'register':
          o.onRegister && o.onRegister(message.kind, message.name);
          break;
      }
    });
    worker.on('error', function (err) {
      if (loading) {
        settle(failure('SANDBOX_FAILED', err.message));
      } else {
        self.fail('the sandbox crashed: ' + err.message);
      }
    });
    worker.on('exit', function (code) {
      if (loading) {
        settle(failure('SANDBOX_FAILED', 'the sandbox exited (' + code + ')'));
      } else if (self.worker === worker) {
        self.fail('the sandbox exited (' + code + ')');
      }
    });
    worker.postMessage({
      type: 'init',
      code: o.code,
      permissions: o.permissions,
      limits: { memoryBytes: o.limits.memoryBytes, stackBytes: o.limits.stackBytes || 512 * 1024, cpuMsPerCall: o.limits.cpuMsPerCall }
    });
  });
};

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return undefined;
  }
}

/** Calls a handler the plugin registered; resolves with its answer (parsed JSON) */
Sandbox.prototype.call = function (kind, name, args, ctx, options) {
  var self = this,
    timeoutMs = (options && options.timeoutMs) || 10000;
  if (this.failed || !this.worker) {
    return Promise.reject(failure('PLUGIN_FAILED', this.failed || 'the plugin isn\'t running'));
  }
  return new Promise(function (resolve, reject) {
    var call = {
      callId: self.nextCallId++,
      message: { kind: kind, name: name, args: JSON.stringify(args === undefined ? null : args), ctx: JSON.stringify(ctx || null) },
      resolve: resolve,
      reject: reject,
      timer: null,
      started: false
    };
    // the timeout includes waiting for a slot: a hook can't hold Play for longer
    call.timer = setTimeout(function () {
      self.finish(call.callId, failure('TIMEOUT', kind + ' ' + name + ' took longer than ' + timeoutMs + ' ms'));
    }, timeoutMs);
    self.calls.set(call.callId, call);
    self.queue.push(call);
    self.next();
  });
};

Sandbox.prototype.next = function () {
  while (this.running < this.options.limits.concurrentCalls && this.queue.length && this.worker) {
    var call = this.queue.shift();
    if (!this.calls.has(call.callId)) {
      continue;   // timed out while waiting
    }
    call.started = true;
    this.running++;
    this.stats.calls++;
    this.worker.postMessage(Object.assign({ type: 'call', callId: call.callId }, call.message));
  }
};

Sandbox.prototype.finish = function (callId, err, value, cpuMs) {
  var call = this.calls.get(callId);
  if (!call) {
    return;
  }
  this.calls.delete(callId);
  clearTimeout(call.timer);
  if (call.started) {
    // a call that timed out keeps its slot until the worker answers it
    if (!err || err.code !== 'TIMEOUT') {
      this.running--;
    } else {
      call.abandoned = true;
      this.abandoned = (this.abandoned || new Map()).set(callId, true);
    }
  } else {
    this.queue = this.queue.filter(function (c) { return c.callId !== callId; });
  }
  if (cpuMs) {
    this.stats.cpuMs += cpuMs;
  }
  if (err) {
    this.stats.errors++;
    if (err.code === 'TIMEOUT') {
      this.stats.timeouts++;
    }
    this.strike(err);
    call.reject(err);
  } else {
    call.resolve(value);
  }
  this.next();
};

Sandbox.prototype.onResult = function (message) {
  if (this.abandoned && this.abandoned.has(message.callId)) {
    this.abandoned.delete(message.callId);
    this.running--;
    this.stats.cpuMs += message.cpuMs || 0;
    if (!message.ok) {
      this.strike(failure(message.error.code, message.error.message));
    }
    this.next();
    return;
  }
  if (message.ok) {
    var value;
    try {
      value = JSON.parse(message.value);
    } catch (e) {
      this.finish(message.callId, failure('BAD_ANSWER', 'the answer isn\'t JSON'), undefined, message.cpuMs);
      return;
    }
    this.finish(message.callId, null, value, message.cpuMs);
  } else {
    this.finish(message.callId, failure(message.error.code, message.error.message), undefined, message.cpuMs);
  }
};

Sandbox.prototype.onHost = function (message) {
  var self = this,
    worker = this.worker,
    args;
  try {
    args = JSON.parse(message.args);
  } catch (e) {
    args = null;
  }
  Promise.resolve().then(function () {
    return self.options.host(message.api, args, message.bytes ? Buffer.from(message.bytes) : null, message.callId);
  }).then(function (result) {
    result = result || {};
    if (worker === self.worker && worker) {
      worker.postMessage({ type: 'reply', hostId: message.hostId, ok: true,
        value: JSON.stringify(result.value === undefined ? null : result.value), bytes: result.bytes || undefined });
    }
  }, function (err) {
    if (worker === self.worker && worker) {
      worker.postMessage({ type: 'reply', hostId: message.hostId, ok: false,
        error: { code: err.code && /^[A-Z_]{2,40}$/.test(err.code) ? err.code : 'HOST_ERROR', message: String(err.message || err).slice(0, 500) } });
    }
  });
};

Sandbox.prototype.strike = function (err) {
  if (COUNTED.indexOf(err.code) === -1) {
    return;
  }
  var now = Date.now();
  this.strikes = this.strikes.filter(function (t) { return now - t < STRIKE_WINDOW_MS; }).concat(now);
  if (this.strikes.length >= STRIKES) {
    this.fail(STRIKES + ' calls stopped by its limits within 10 minutes (last: ' + err.code + ')');
  }
};

/** Stops the sandbox for good: every pending call fails, onFailed(reason) */
Sandbox.prototype.fail = function (reason) {
  if (this.failed) {
    return;
  }
  this.failed = reason;
  this.stop();
  if (this.options.onFailed) {
    this.options.onFailed(reason);
  }
};

Sandbox.prototype.stop = function () {
  var worker = this.worker, self = this;
  this.worker = null;
  if (worker) {
    worker.terminate().catch(function () {});
  }
  Array.from(this.calls.keys()).forEach(function (callId) {
    var call = self.calls.get(callId);
    self.calls.delete(callId);
    clearTimeout(call.timer);
    call.reject(failure('PLUGIN_FAILED', self.failed || 'the plugin stopped'));
  });
  this.queue = [];
  this.running = 0;
};

module.exports = Sandbox;
