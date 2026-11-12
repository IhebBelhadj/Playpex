'use strict';

// Managed plugins (docs/plugin-layer-plan.md §9): plugins the core makes
// rather than unpacks. A built-in **provider** turns what the admin gives (a
// Stremio add-on's URL, for the bridge) into a manifest and files whose
// server.js is code the server ships (../builtin). They go through the same
// pipeline as packages (../install.js: staged → preview with the permissions
// in words and what an update adds → commit → the previous version kept for a
// rollback), as origin `managed`; trusted by being built in, never by a
// signature or developer mode.
//
//   provider = { name, label, code (a builtin name), secretInput?, build(input, current?) → Promise<{ manifest, assets?, summary? }> }
//   register(provider) / unregister(name) / providers()
//   inspect(name, input) → the staged preview (+ `summary`): installed with POST /admin/plugins/packages/:token/install
//   reconfigure(id, input) → a staged preview of the same plugin built from a new input
//   check(id) → a staged preview when its provider builds something new, else { upToDate: true }
//   inputOf(id) → its input (the core's: a plugin never reads it)
//   refresh() → every managed plugin rebuilt when the server ships other code for it (at start; daily)
//   record(id, entry) / forget(id)   install.js writes / removes managed.json and the input
//
// The input is kept as the plugin's secret `managed:input` (sealed like every
// secret) when the provider says it holds one (`secretInput`): a name no
// manifest can declare, so the plugin's own code can't read it.

var fs = require('fs'),
  path = require('path'),
  builtin = require('../builtin'),
  userData = require('../../userData'),
  log = require('../../logger').child('plugins');

var INFO = 'managed.json',
  INPUT_SECRET = 'managed:input',
  CHECK_MS = 24 * 60 * 60 * 1000;

var registry = {},
  timer = null;

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function install() {
  return require('../install');
}

function register(provider) {
  if (!provider || !/^[a-z][a-z0-9-]{1,31}$/.test(provider.name || '') || typeof provider.build !== 'function') {
    throw new Error('a managed provider needs a name and build()');
  }
  if (!builtin.code(provider.code)) {
    throw new Error('managed provider ' + provider.name + ': no shipped code ' + provider.code);
  }
  registry[provider.name] = provider;
}

function unregister(name) {
  delete registry[name];
}

function providers() {
  return Object.keys(registry).map(function (n) { return { name: n, label: registry[n].label || n }; });
}

function providerOf(name) {
  var p = registry[name];
  if (!p) {
    throw failure('NOT_FOUND', 'No managed plugin provider ' + name);
  }
  return p;
}

/** The files a build gives: its manifest, the shipped server.js, its assets ({ path: Buffer }) */
function filesOf(provider, built) {
  var code = builtin.code(provider.code),
    files = [
      { path: 'playpex-plugin.json', bytes: Buffer.from(JSON.stringify(built.manifest, null, 2)) },
      { path: 'server.js', bytes: Buffer.from(code.text, 'utf8') }
    ];
  Object.keys(built.assets || {}).forEach(function (p) {
    if (/^assets\/[A-Za-z0-9_-][A-Za-z0-9_./-]{0,120}$/.test(p) && p.indexOf('..') === -1) {
      files.push({ path: p, bytes: Buffer.from(built.assets[p]) });
    }
  });
  return files;
}

function stageBuilt(provider, input, built) {
  var files = filesOf(provider, built);
  return install().stageFiles({ files: files, root: null }, {
    origin: 'managed',
    source: provider.name,
    managed: { provider: provider.name, input: input, secretInput: !!provider.secretInput, codeHash: builtin.sha256(builtin.code(provider.code).text) }
  }, files.reduce(function (n, f) { return n + f.bytes.length; }, 0)).then(function (preview) {
    return Object.assign(preview, { summary: built.summary || null });
  });
}

function infoOf(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(install().dirOf(id), INFO), 'utf8'));
  } catch (e) {
    return null;
  }
}

function inputOf(id) {
  var info = infoOf(id);
  if (!info) {
    return Promise.resolve(null);
  }
  if (!info.secretInput) {
    return Promise.resolve(info.input === undefined ? null : info.input);
  }
  return userData.services().then(function (s) {
    return s.plugins.secrets.get(id, INPUT_SECRET).then(function (v) { return v === null ? null : JSON.parse(v); });
  });
}

function inspect(name, input) {
  var provider;
  try {
    provider = providerOf(name);
  } catch (e) {
    return Promise.reject(e);
  }
  return Promise.resolve(provider.build(input, null)).then(function (built) {
    return stageBuilt(provider, input, built);
  });
}

function rebuild(id, input) {
  var info = infoOf(id);
  if (!info) {
    return Promise.reject(failure('NOT_FOUND', id + ' isn\'t a managed plugin'));
  }
  var provider;
  try {
    provider = providerOf(info.provider);
  } catch (e) {
    return Promise.reject(e);
  }
  var current = install().installedManifest(id);
  return (input === undefined ? inputOf(id) : Promise.resolve(input)).then(function (value) {
    return Promise.resolve(provider.build(value, current)).then(function (built) {
      if (built.manifest.id !== id) {
        throw failure('INVALID', 'that builds ' + built.manifest.id + ', not ' + id + ': add it as another plugin');
      }
      return { provider: provider, input: value, built: built, current: current, info: info };
    });
  });
}

function reconfigure(id, input) {
  return rebuild(id, input).then(function (r) { return stageBuilt(r.provider, r.input, r.built); });
}

/** What would change: another manifest, or other shipped code */
function changed(r) {
  var code = builtin.code(r.provider.code);
  return JSON.stringify(r.built.manifest) !== JSON.stringify(r.current) || builtin.sha256(code.text) !== r.info.codeHash;
}

function check(id) {
  return rebuild(id).then(function (r) {
    return changed(r) ? stageBuilt(r.provider, r.input, r.built) : { upToDate: true, id: id };
  });
}

/**
 * Every managed plugin its provider builds differently now (new shipped code,
 * the service's new version): installed at once when it asks for nothing
 * more, else left for the admin (Check for updates shows what it adds)
 */
function refresh() {
  return userData.services().then(function (s) {
    return s.plugins.installed.list();
  }).then(function (rows) {
    var managed = rows.filter(function (r) { return r.origin === 'managed'; });
    return managed.reduce(function (chain, row) {
      return chain.then(function () {
        if (!registry[row.source]) {
          return null;
        }
        return check(row.id).then(function (preview) {
          if (preview.upToDate) {
            return null;
          }
          if (preview.added && preview.added.length) {
            log.info('plugin ' + row.id + ': a new build asks for more (' + preview.added.map(function (x) { return x.text; }).join('; ') +
              '): waiting for the admin', { plugin: row.id });
            return null;
          }
          return install().commit(preview.token, {}).then(function () {
            log.info('plugin ' + row.id + ' rebuilt (' + row.source + ')', { plugin: row.id });
          });
        }).catch(function (err) {
          log.warn('plugin ' + row.id + ': not rebuilt: ' + err.message, { plugin: row.id });
        });
      });
    }, Promise.resolve());
  });
}

/** install.js, once a managed plugin's files are written: its record and its input */
function record(id, from) {
  var m = from.managed;
  fs.writeFileSync(path.join(install().dirOf(id), INFO), JSON.stringify({
    provider: m.provider, codeHash: m.codeHash, secretInput: m.secretInput, builtAt: new Date().toISOString(),
    input: m.secretInput ? undefined : m.input
  }, null, 2));
  // a rollback keeps the input where it is
  if (!m.secretInput || m.input === undefined) {
    return Promise.resolve();
  }
  return userData.services().then(function (s) {
    return s.plugins.secrets.set(id, INPUT_SECRET, JSON.stringify(m.input === undefined ? null : m.input));
  });
}

function start(options) {
  options = options || {};
  stop();
  if (options.intervalMs === false) {
    return;
  }
  timer = setInterval(function () {
    refresh().catch(function () {});
  }, options.intervalMs || CHECK_MS);
  if (timer.unref) {
    timer.unref();
  }
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  register: register,
  unregister: unregister,
  providers: providers,
  inspect: inspect,
  reconfigure: reconfigure,
  check: check,
  refresh: refresh,
  inputOf: inputOf,
  infoOf: infoOf,
  record: record,
  start: start,
  stop: stop,
  INPUT_SECRET: INPUT_SECRET
};
