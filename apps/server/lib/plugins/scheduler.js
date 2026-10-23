'use strict';

// Scheduled work (docs/plugins-plan.md §4.5): `playpex.schedule.every(name,
// interval, handler, { atStart })` from a plugin's code (permissions.schedule).
// The host calls the handler on that interval while the plugin is enabled:
// at least LIMITS.schedule.minIntervalMs apart, ±10 % jitter, never two runs
// of one job at once (a run still going when the next is due skips it), a
// run's wall time capped at LIMITS.schedule.maxRunMs (its CPU counts like any
// call). The first run comes one interval after it was declared, or a minute
// after the server started with atStart. Jobs are declared again each time
// the plugin's code loads (so they survive restarts) and stop with it. A
// job's context has no profile: it asks `playpex.profiles.list(permission)`
// for the profiles granted what it needs.

var protocol = require('@playpex/protocol/plugins'),
  log = require('../logger').child('plugins');

var LIMITS = protocol.LIMITS.schedule,
  UNITS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 },
  startedAt = Date.now();

var jobs = new Map(),        // plugin id → Map name → job
  testing = { minIntervalMs: null, startDelayMs: null };

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

/** '15m', '1h', '90s', '1d' or milliseconds → ms, or null */
function parseInterval(value) {
  if (typeof value === 'number' && isFinite(value) && value > 0) {
    return Math.round(value);
  }
  var m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(String(value || '').trim());
  return m ? Math.round(Number(m[1]) * UNITS[m[2]]) : null;
}

function minInterval() {
  return testing.minIntervalMs !== null ? testing.minIntervalMs : LIMITS.minIntervalMs;
}

function jitter(ms) {
  return Math.round(ms * (1 + (Math.random() * 2 - 1) * LIMITS.jitter));
}

function arm(job, delay) {
  clearTimeout(job.timer);
  job.nextRunAt = Date.now() + delay;
  job.timer = setTimeout(function () { run(job); }, delay);
  if (job.timer.unref) {
    job.timer.unref();
  }
}

function run(job) {
  arm(job, jitter(job.intervalMs));
  var plugin = job.plugin;
  if (plugin.state !== 'enabled' || !plugin.sandbox) {
    return;
  }
  if (job.running) {
    job.skipped++;
    log.info('plugin ' + plugin.id + ' job ' + job.name + ' skipped: the last run is still going', { plugin: plugin.id });
    return;
  }
  job.running = true;
  var began = Date.now();
  plugin.sandbox.call('job', job.name, null, { profile: null, device: null, locale: 'en' }, { timeoutMs: LIMITS.maxRunMs }).then(function () {
    job.lastError = null;
  }, function (err) {
    job.lastError = (err.code ? err.code + ': ' : '') + err.message;
    job.errors++;
    log.warn('plugin ' + plugin.id + ' job ' + job.name + ' failed: ' + err.message, { plugin: plugin.id, code: err.code });
  }).then(function () {
    job.running = false;
    job.runs++;
    job.lastRunAt = new Date(began);
    job.lastDurationMs = Date.now() - began;
  });
}

/** The host's schedule.every: declares (or declares again) a job of `plugin` */
function every(plugin, name, interval, options) {
  if (typeof name !== 'string' || !/^[a-z][A-Za-z0-9]{0,39}$/.test(name)) {
    throw failure('INVALID', 'a job name is [a-z][A-Za-z0-9]{0,39}');
  }
  var ms = parseInterval(interval);
  if (!ms) {
    throw failure('INVALID', 'interval must be like "15m", "1h", "1d" or milliseconds');
  }
  if (ms < minInterval()) {
    throw failure('INVALID', 'a job runs at most every ' + Math.round(minInterval() / 60000) + ' minutes');
  }
  var list = jobs.get(plugin.id);
  if (!list) {
    list = new Map();
    jobs.set(plugin.id, list);
  }
  var job = list.get(name);
  if (job) {
    clearTimeout(job.timer);
  } else {
    job = { name: name, runs: 0, errors: 0, skipped: 0, lastRunAt: null, lastDurationMs: null, lastError: null, running: false };
    list.set(name, job);
  }
  job.plugin = plugin;
  job.intervalMs = ms;
  var atStart = !!(options && options.atStart),
    startDelay = testing.startDelayMs !== null ? testing.startDelayMs : 60 * 1000;
  arm(job, atStart ? Math.max(0, startedAt + startDelay - Date.now()) : jitter(ms));
  return true;
}

function cancel(pluginId, name) {
  var list = jobs.get(pluginId), job = list && list.get(name);
  if (!job) {
    return false;
  }
  clearTimeout(job.timer);
  list.delete(name);
  return true;
}

/** A plugin unloaded (or the server stops): its jobs stop */
function stop(pluginId) {
  var list = jobs.get(pluginId);
  if (list) {
    list.forEach(function (job) { clearTimeout(job.timer); });
    jobs.delete(pluginId);
  }
}

function stopAll() {
  Array.from(jobs.keys()).forEach(stop);
}

/** The dashboard's view of a plugin's jobs */
function view(pluginId) {
  var list = jobs.get(pluginId);
  return list ? Array.from(list.values()).map(function (job) {
    return {
      name: job.name,
      intervalMs: job.intervalMs,
      runs: job.runs,
      errors: job.errors,
      skipped: job.skipped,
      running: job.running,
      lastRunAt: job.lastRunAt ? job.lastRunAt.toISOString() : null,
      lastDurationMs: job.lastDurationMs,
      lastError: job.lastError,
      nextRunAt: job.nextRunAt ? new Date(job.nextRunAt).toISOString() : null
    };
  }) : [];
}

/** Tests only: shorter intervals and start delay */
function configure(options) {
  testing = Object.assign({ minIntervalMs: null, startDelayMs: null }, options || {});
  startedAt = Date.now();
}

module.exports = {
  every: every,
  cancel: cancel,
  stop: stop,
  stopAll: stopAll,
  view: view,
  parseInterval: parseInterval,
  configure: configure
};
