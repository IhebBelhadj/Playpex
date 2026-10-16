'use strict';

// The server core in an Electron utilityProcess (docs/server-separation-plan.md
// §8.1): Electron's own Node runs @playpex/server's headless entry, which
// talks to us over process.parentPort (the messages are described in
// apps/server/lib/host.js).
//
//   const server = new ServerProcess({ entry, env })
//   server.start() / server.stop() → Promise / server.restart()
//   server.state    'starting' | 'running' | 'recovery' | 'stopping' | 'stopped' | 'crashed' | 'error'
//   server.status   the server's last status (port, dashboardUrl, streams, pairing…), or null
//   server.error    what went wrong in 'crashed' / 'error'
//   server.request(action, args) → Promise    e.g. 'pairing.approve', { code }
//   server.handle(action, fn)                 answers the server's requests (desktop.set…)
//   server.send(message)
//   events: 'change' (state or status), 'event' ({topic, data}: pairing.*, device.*, session.*)
//
// Crash handling: an exit we didn't ask for restarts the server after 1 s,
// 5 s, then 30 s; after 5 crashes in 10 minutes it stays down ('error')
// until restart() (the tray's Restart server).

const { utilityProcess } = require('electron');
const EventEmitter = require('events');

const BACKOFF_MS = [1000, 5000, 30000];
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const MAX_CRASHES = 5;
const STOP_TIMEOUT_MS = 12000;   // the server gives itself 10 s
const REQUEST_TIMEOUT_MS = 15000;

class ServerProcess extends EventEmitter {
  constructor(options) {
    super();
    this.entry = options.entry;
    this.env = options.env || process.env;
    this.stdio = options.stdio || 'ignore';
    this.child = null;
    this.state = 'stopped';
    this.status = null;
    this.error = null;
    this.crashes = [];          // times of recent crashes
    this.retryTimer = null;
    this.stopping = null;       // Promise while stopping
    this.fatal = null;          // the server's last 'fatal' message
    this.pending = new Map();   // request id → { resolve, reject, timer }
    this.handlers = {};
    this.nextId = 1;
  }

  setState(state, error) {
    this.state = state;
    this.error = error || null;
    this.emit('change');
  }

  start() {
    if (this.child) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.fatal = null;
    this.status = null;
    this.setState('starting');
    const child = utilityProcess.fork(this.entry, [], {
      serviceName: 'Playpex Media Server',
      env: this.env,
      stdio: this.stdio
    });
    this.child = child;
    child.on('message', message => this.onMessage(message));
    child.on('exit', code => this.onExit(child, code));
  }

  onMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    switch (message.type) {
      case 'status': {
        const first = !this.status || this.status.state === 'starting';
        this.status = message.status;
        const state = message.status.state === 'recovery' ? 'recovery' :
          message.status.state === 'running' ? 'running' : 'starting';
        this.setState(this.state === 'stopping' ? 'stopping' : state);
        if (state !== 'starting' && first) {
          this.emit('started', this.status);
        }
        break;
      }
      case 'event':
        this.emit('event', { topic: message.topic, data: message.data });
        break;
      case 'fatal':
        this.fatal = message;
        break;
      case 'request':
        this.answer(message);
        break;
      case 'reply': {
        const waiting = this.pending.get(message.id);
        if (waiting) {
          this.pending.delete(message.id);
          clearTimeout(waiting.timer);
          if (message.ok) {
            waiting.resolve(message.result);
          } else {
            const err = new Error(message.error || 'The server refused');
            err.code = message.code;
            waiting.reject(err);
          }
        }
        break;
      }
    }
  }

  answer(message) {
    const fn = this.handlers[message.action];
    Promise.resolve().then(() => {
      if (!fn) {
        const err = new Error('Unknown action ' + message.action);
        err.code = 'NOT_FOUND';
        throw err;
      }
      return fn(message.args || {});
    }).then(result => {
      this.send({ type: 'reply', id: message.id, ok: true, result: result === undefined ? null : result });
    }, err => {
      this.send({ type: 'reply', id: message.id, ok: false, error: err.message, code: err.code || 'INTERNAL' });
    });
  }

  onExit(child, code) {
    if (child !== this.child) {
      return;
    }
    this.child = null;
    this.status = null;
    this.pending.forEach(waiting => {
      clearTimeout(waiting.timer);
      waiting.reject(Object.assign(new Error('The server stopped'), { code: 'INTERNAL' }));
    });
    this.pending.clear();
    if (this.state === 'stopping') {
      this.setState('stopped');
      return;
    }
    const fatal = this.fatal;
    if (fatal && fatal.playpex) {
      // Another Playpex server (npm run server, the TV app) holds our port:
      // restarting won't help
      this.setState('error', { message: 'Another Playpex server is running on port ' + fatal.port, port: fatal.port, code: fatal.code });
      return;
    }
    const now = Date.now();
    this.crashes = this.crashes.filter(t => now - t < CRASH_WINDOW_MS).concat(now);
    const message = fatal ? fatal.message : 'The server stopped unexpectedly (exit code ' + code + ')';
    if (this.crashes.length >= MAX_CRASHES) {
      this.setState('error', { message: message + '; gave up after ' + MAX_CRASHES + ' crashes in 10 minutes', code: fatal && fatal.code });
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.crashes.length - 1, BACKOFF_MS.length - 1)];
    this.setState('crashed', { message: message, retryInMs: delay, code: fatal && fatal.code });
    this.retryTimer = setTimeout(() => this.start(), delay);
  }

  send(message) {
    if (this.child) {
      this.child.postMessage(message);
    }
  }

  request(action, args) {
    if (!this.child) {
      return Promise.reject(Object.assign(new Error('The server is not running'), { code: 'INTERNAL' }));
    }
    const id = 'd' + this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id);
          reject(Object.assign(new Error('The server did not answer'), { code: 'INTERNAL' }));
        }, REQUEST_TIMEOUT_MS)
      });
      this.send({ type: 'request', id, action, args: args || {} });
    });
  }

  handle(action, fn) {
    this.handlers[action] = fn;
  }

  // Graceful: the server destroys its torrent engines and closes the database
  stop() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.child) {
      if (this.state !== 'stopped') {
        this.setState('stopped');
      }
      return Promise.resolve();
    }
    if (this.stopping) {
      return this.stopping;
    }
    const child = this.child;
    this.setState('stopping');
    this.stopping = new Promise(resolve => {
      const timer = setTimeout(() => child.kill(), STOP_TIMEOUT_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage({ type: 'stop' });
    }).then(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  // The tray's Restart server: also leaves the 'error' state
  restart() {
    this.crashes = [];
    return this.stop().then(() => this.start());
  }
}

module.exports = ServerProcess;
