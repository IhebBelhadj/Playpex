'use strict';

// The plugin host (docs/plugins-plan.md §4, step P2): loads plugins, runs
// each in its own sandbox (./sandbox.js → ./worker.js, QuickJS in WASM), and
// is the only way the rest of the server reaches them.
//
//   start({ dirs?, developerMode?, http?, installed? }) / stop()      from index.js
//     the installed packages first (./install.js, <config>/plugins/<id>/;
//     installed: false skips them), then dirs: plugin folders to load
//     (tests), then with developerMode (settings plugins.developerMode)
//     every folder of <config>/plugins-dev/ (unsigned, the author's own)
//   load(dir, origin) → Promise<plugin>   a folder holding playpex-plugin.json + server.js (+ assets/, i18n/)
//   unload(id)
//   runHook(name, input, ctx, { only?, timeoutMs? }) → Promise<{ results: [{ plugin, output }], errors: [{ plugin, code, message }] }>
//     every enabled plugin with that hook (or only the plugin `only`): a
//     handler that fails, times out or answers out of schema is skipped (plan
//     §4.3), the others' answers come back, in plugin id order
//   withHook(name, ctx?) → [{ id, name }]   the enabled plugins having it (providers, matchers)
//   data(id, name, args, ctx) → Promise<{ data, effects }>   a client's call (lib/routes/plugins.js)
//   clientView(profile) → what clients render (GET /plugins)
//   list() / get(id) / all()             the admin's view (./install.js#list for the dashboard), one, every loaded plugin
//
// ctx = { profile: { id, kids } | null, device: { id, name } | null, locale }:
// an `audience: adults` plugin never gets a kids profile's call (FORBIDDEN).
// Events: `plugin.changed` { id, state } (every client: refetch GET /plugins).

var fs = require('fs'),
  path = require('path'),
  protocol = require('@playpex/protocol/plugins'),
  Sandbox = require('./sandbox'),
  createHost = require('./host').createHost,
  schemas = require('./schemas'),
  effects = require('./effects'),
  http = require('./http'),
  paths = require('../paths'),
  events = require('../events'),
  userData = require('../userData'),
  logger = require('../logger'),
  log = logger.child('plugins');

var MANIFEST = 'playpex-plugin.json',
  MANIFEST_MAX = 256 * 1024,
  CODE_MAX = 5 * 1024 * 1024,
  FILES_MAX = 2000,
  DATA_TIMEOUT_MS = 10000,
  SANDBOX_LIMITS = Object.assign({ stackBytes: 512 * 1024 }, protocol.LIMITS);

var plugins = new Map(),
  started = false;

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function devDir() {
  return path.join(paths.config, 'plugins-dev');
}

/** Every file of a package folder, relative, `/`-separated; no symlinks */
function filesOf(dir) {
  var out = [];
  (function walk(rel) {
    fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).forEach(function (entry) {
      var name = rel ? rel + '/' + entry.name : entry.name;
      if (out.length >= FILES_MAX) {
        throw failure('INVALID', 'more than ' + FILES_MAX + ' files');
      }
      if (entry.isSymbolicLink()) {
        throw failure('INVALID', name + ' is a symbolic link');
      }
      if (entry.isDirectory()) {
        walk(name);
      } else if (entry.isFile()) {
        out.push(name);
      }
    });
  })('');
  return out;
}

function readJson(file, max) {
  var stat = fs.statSync(file);
  if (stat.size > max) {
    throw failure('INVALID', path.basename(file) + ' is too large');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** i18n/<locale>.json files: { locale: { key: text } } */
function stringsOf(dir, files) {
  var out = {};
  files.forEach(function (f) {
    var m = /^i18n\/([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\.json$/.exec(f);
    if (m) {
      var table = readJson(path.join(dir, f), MANIFEST_MAX);
      if (!table || typeof table !== 'object' || Array.isArray(table)) {
        throw failure('INVALID', f + ' must be an object of strings');
      }
      out[m[1]] = table;
    }
  });
  return out;
}

function publish(plugin) {
  events.publish('plugin.changed', { id: plugin.id, state: plugin.state });
}

/**
 * Loads a plugin folder and starts its sandbox. A plugin that can't start
 * stays listed (state `failed`, `error`) for the dashboard.
 */
function load(dir, origin) {
  var plugin;
  return Promise.resolve().then(function () {
    var files = filesOf(dir),
      manifest = readJson(path.join(dir, MANIFEST), MANIFEST_MAX),
      strings = stringsOf(dir, files),
      problems = schemas.manifestProblems(manifest, { files: files, strings: strings });
    if (problems.length) {
      throw failure('INVALID_MANIFEST', problems.join('; '));
    }
    if (manifest.type === 'repository') {
      throw failure('INVALID_MANIFEST', 'a repository package adds a repository (plugins plan step P4b), it doesn\'t run');
    }
    if (plugins.has(manifest.id)) {
      throw failure('CONFLICT', 'a plugin ' + manifest.id + ' is already loaded');
    }
    if (files.indexOf('server.js') === -1) {
      throw failure('INVALID', 'no server.js');
    }
    var codeFile = path.join(dir, 'server.js');
    if (fs.statSync(codeFile).size > CODE_MAX) {
      throw failure('INVALID', 'server.js is larger than 5 MB');
    }
    plugin = {
      id: manifest.id,
      dir: dir,
      origin: origin || 'dev',
      manifest: manifest,
      // what the admin granted: the manifest's, until install / consent exist (step P4)
      permissions: manifest.permissions,
      files: files,
      state: 'loading',
      error: null,
      registered: { hook: [], data: [], event: [], job: [] },
      stats: { host: {}, hooks: {}, data: {}, loadedAt: null },
      sandbox: null,
      strings: function (locale) {
        return locale ? strings[locale] || strings[String(locale).split('-')[0]] || null : null;
      }
    };
    plugins.set(plugin.id, plugin);
    var tagged = logger.child('plugins');
    plugin.sandbox = new Sandbox({
      id: plugin.id,
      code: fs.readFileSync(codeFile, 'utf8'),
      permissions: plugin.permissions,
      limits: SANDBOX_LIMITS,
      host: createHost(plugin, userData.services),
      onLog: function (level, message, fields) {
        tagged[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']('[' + plugin.id + '] ' + message,
          Object.assign({ plugin: plugin.id }, fields && typeof fields === 'object' ? { fields: fields } : {}));
      },
      onRegister: function (kind, name) {
        if (plugin.registered[kind].indexOf(name) === -1) {
          plugin.registered[kind].push(name);
        }
      },
      onFailed: function (reason) {
        plugin.state = 'failed';
        plugin.error = reason;
        log.error('plugin ' + plugin.id + ' stopped: ' + reason, { plugin: plugin.id });
        publish(plugin);
      }
    });
    return plugin.sandbox.start();
  }).then(function (registered) {
    plugin.registered = registered;
    plugin.state = 'enabled';
    plugin.stats.loadedAt = new Date();
    log.info('plugin ' + plugin.id + ' ' + plugin.manifest.version + ' loaded', {
      plugin: plugin.id, hooks: registered.hook, data: registered.data
    });
    publish(plugin);
    return plugin;
  }, function (err) {
    if (plugin) {
      plugin.state = 'failed';
      plugin.error = (err.code ? err.code + ': ' : '') + err.message;
      publish(plugin);
    }
    log.error('plugin in ' + dir + ' not loaded: ' + err.message, { code: err.code });
    throw err;
  });
}

function unload(id) {
  var plugin = plugins.get(id);
  if (!plugin) {
    return false;
  }
  plugins.delete(id);
  if (plugin.sandbox) {
    plugin.sandbox.stop();
  }
  require('./remote').forget(id);
  plugin.state = 'removed';
  publish(plugin);
  return true;
}

function start(options) {
  options = options || {};
  started = true;
  if (options.http) {
    http.configure(options.http);
  }
  var dirs = (options.dirs || []).map(function (d) { return { dir: d, origin: 'dev' }; });
  if (options.developerMode) {
    try {
      fs.readdirSync(devDir(), { withFileTypes: true }).forEach(function (e) {
        if (e.isDirectory()) {
          dirs.push({ dir: path.join(devDir(), e.name), origin: 'dev' });
        }
      });
    } catch (e) {
      if (e.code !== 'ENOENT') {
        log.warn('developer plugins not read: ' + e.message);
      }
    }
    log.warn('plugins developer mode is on: unsigned plugins from ' + devDir() + ' run');
  }
  var installed = options.installed === false ? Promise.resolve() : require('./install').loadInstalled();
  return installed.then(function () {
    return Promise.all(dirs.map(function (d) {
      return load(d.dir, d.origin).catch(function () { return null; });
    }));
  });
}

function stop() {
  started = false;
  Array.from(plugins.keys()).forEach(function (id) {
    var plugin = plugins.get(id);
    plugins.delete(id);
    if (plugin.sandbox) {
      plugin.sandbox.stop();
    }
    require('./remote').forget(id);
  });
  return Promise.resolve();
}

function kidsBlocked(plugin, ctx) {
  return plugin.manifest.audience === 'adults' && !!(ctx && ctx.profile && ctx.profile.kids);
}

function bump(table, key, field) {
  var row = table[key] = table[key] || { calls: 0, errors: 0 };
  row[field]++;
}

function hooked(name, ctx) {
  return Array.from(plugins.values()).filter(function (plugin) {
    return plugin.state === 'enabled' && plugin.registered.hook.indexOf(name) !== -1 &&
      (plugin.permissions.hooks || []).indexOf(name) !== -1 && !kidsBlocked(plugin, ctx);
  }).sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
}

/** The enabled plugins with a hook: [{ id, name }] (release / subtitle providers, matchers) */
function withHook(name, ctx) {
  return hooked(name, ctx).map(function (plugin) {
    return { id: plugin.id, name: plugin.manifest.name };
  });
}

/** Runs a hook on every enabled plugin that has it (plan §4.3) */
function runHook(name, input, ctx, options) {
  options = options || {};
  var hook = protocol.HOOKS[name];
  if (!hook) {
    return Promise.reject(failure('INVALID', 'no hook ' + name));
  }
  var inputProblem = schemas.hookProblem(name, 'input', input);
  if (inputProblem) {
    return Promise.reject(failure('INVALID', name + ' input: ' + inputProblem));
  }
  var answers = {}, errors = [];
  var chosen = hooked(name, ctx).filter(function (plugin) {
    return !options.only || plugin.id === options.only;
  });
  var runs = chosen.map(function (plugin) {
    bump(plugin.stats.hooks, name, 'calls');
    return plugin.sandbox.call('hook', name, input, ctx, { timeoutMs: options.timeoutMs || hook.timeoutMs }).then(function (output) {
      var problem = schemas.hookProblem(name, 'output', output);
      if (problem) {
        throw failure('BAD_ANSWER', problem);
      }
      answers[plugin.id] = output;
    }).catch(function (err) {
      bump(plugin.stats.hooks, name, 'errors');
      log.warn('plugin ' + plugin.id + ' ' + name + ' skipped: ' + err.message, { plugin: plugin.id, code: err.code });
      errors.push({ plugin: plugin.id, code: err.code || 'HANDLER_ERROR', message: err.message });
    });
  });
  return Promise.all(runs).then(function () {
    return {
      results: chosen.filter(function (p) { return answers.hasOwnProperty(p.id); }).map(function (p) {
        return { plugin: p.id, output: answers[p.id] };
      }),
      errors: errors
    };
  });
}

/** A client's call to one of a plugin's data handlers */
function data(id, name, args, ctx) {
  var plugin = plugins.get(id);
  if (!plugin || plugin.state !== 'enabled') {
    return Promise.reject(failure('NOT_FOUND', 'no plugin ' + id));
  }
  if (kidsBlocked(plugin, ctx)) {
    return Promise.reject(failure('FORBIDDEN', 'not for kids profiles'));
  }
  if (plugin.registered.data.indexOf(name) === -1) {
    return Promise.reject(failure('NOT_FOUND', 'plugin ' + id + ' has no data handler ' + name));
  }
  bump(plugin.stats.data, name, 'calls');
  return plugin.sandbox.call('data', name, args === undefined ? null : args, ctx, { timeoutMs: DATA_TIMEOUT_MS }).then(function (answer) {
    var problem = schemas.apiProblem('dataAnswer', answer || {});
    if (problem) {
      throw failure('BAD_ANSWER', problem);
    }
    var checked = effects.filter(plugin, answer && answer.effects);
    if (checked.dropped.length) {
      log.warn('plugin ' + id + ' ' + name + ': effects dropped: ' + checked.dropped.join('; '), { plugin: id });
    }
    return { data: answer && answer.data !== undefined ? answer.data : null, effects: checked.effects };
  }).catch(function (err) {
    bump(plugin.stats.data, name, 'errors');
    if (err.code !== 'NOT_FOUND' && err.code !== 'FORBIDDEN') {
      log.warn('plugin ' + id + ' data ' + name + ' failed: ' + err.message, { plugin: id, code: err.code });
      err.code = 'PLUGIN_FAILED';
    }
    throw err;
  });
}

/** What a client renders: enabled plugins for this profile, never permissions, settings or state */
function clientView(profile) {
  return Array.from(plugins.values()).filter(function (plugin) {
    return plugin.state === 'enabled' && !kidsBlocked(plugin, { profile: profile });
  }).map(function (plugin) {
    var m = plugin.manifest, c = m.contributes || {};
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      audience: m.audience,
      icon: m.icon || null,
      assets: '/plugins/' + m.id + '/assets/',   // under the API prefix
      sections: c.sections || [],
      screens: c.screens || [],
      slots: c.slots || [],
      chrome: c.chrome || null
    };
  });
}

function adminView(plugin) {
  return {
    id: plugin.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    origin: plugin.origin,
    state: plugin.state,
    error: plugin.error,
    permissions: protocol.describePermissions(plugin.manifest),
    registered: plugin.registered,
    stats: Object.assign({}, plugin.stats, { sandbox: plugin.sandbox ? plugin.sandbox.stats : null })
  };
}

function list() {
  return Array.from(plugins.values()).map(adminView);
}

/** The loaded plugin (internal: assets, tests), or null */
function get(id) {
  return plugins.get(id) || null;
}

module.exports = {
  start: start,
  stop: stop,
  load: load,
  unload: unload,
  runHook: runHook,
  withHook: withHook,
  data: data,
  clientView: clientView,
  list: list,
  get: get,
  all: function () { return Array.from(plugins.values()); },
  devDir: devDir,
  isStarted: function () { return started; }
};
