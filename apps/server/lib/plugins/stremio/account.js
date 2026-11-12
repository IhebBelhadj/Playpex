'use strict';

// Import from Stremio (docs/stremio-bridge-plan.md §5.4, decision G): the
// admin's Stremio account lists the add-ons installed there; the admin ticks
// some, and each is installed through the bridge as if its address had been
// pasted. Stremio's account API isn't a documented public one: when it
// changes, this goes (the bridge itself doesn't need it).
//
//   list(email, password) → { session, addons: [item] }
//     signs in, reads the account's add-on collection, signs out at once; the
//     password and Stremio's session key are never stored, logged or answered.
//     The add-ons' addresses (which may hold their keys) stay on the server, in
//     the import session (15 min): the dashboard sees names and what they offer.
//     item: { key, name, version, description, host, configured, official, usable, reason, installed, checked, offers }
//   listed(pluginId) → { session, addons: [item] }   the add-ons a bridged add-on lists (its addon_catalog: Cinemeta's
//     community add-ons), offered as an import is; the add-on, not Playpex, names them
//   install(session, keys) → { installed: [{ key, id, name }], failed: [{ key, name, error }] }
//   configure({ base })   tests: another API address

var crypto = require('crypto'),
  http = require('../http'),
  stremio = require('@playpex/protocol/stremio'),
  manifests = require('./manifest'),
  log = require('../../logger').child('plugins');

var SESSION_MS = 15 * 60 * 1000,
  ADDONS_MAX = 200,
  // Stremio's own: Cinemeta repeats TMDB, OpenSubtitles v3 is a core subtitle provider, the others are its app's
  DEFAULT_OFF = ['com.linvo.cinemeta', 'org.stremio.opensubtitlesv3', 'org.stremio.local', 'com.stremio.watchhub', 'org.stremio.youtube'];

var testing = { base: 'https://api.strem.io' },
  sessions = new Map();   // id → { at, addons: [{ key, url, name }] }

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

var WHO = { id: 'stremio-import', permissions: { network: [] }, anyHost: true, stats: { host: {} } };

/** One call of Stremio's API: { result } or its error in words (never the password) */
function api(method, body) {
  return http.request(WHO, {
    url: testing.base + '/api/' + method,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body,
    responseType: 'json'
  }).then(function (r) {
    var answer = r.value.body;
    if (answer && answer.error) {
      var e = answer.error;
      // 400, not 401: a 401 would read as the dashboard's own session ending
      throw failure(e.wrongPass || e.code === 3 || e.code === 2 ? 'INVALID' : 'UPSTREAM',
        e.wrongPass || e.code === 3 ? 'Stremio says the e-mail or password is wrong' : 'Stremio refused: ' + String(e.message || e.code).slice(0, 120));
    }
    if (!answer || !answer.result) {
      throw failure('UPSTREAM', 'Stremio answered HTTP ' + r.value.status);
    }
    return answer.result;
  }, function (err) {
    throw failure('UPSTREAM', 'Stremio didn\'t answer (' + (err.code || err.message) + ')');
  });
}

function sweep() {
  var now = Date.now();
  sessions.forEach(function (s, id) {
    if (now - s.at > SESSION_MS) {
      sessions.delete(id);
    }
  });
}

/** What the dashboard sees of one add-on of the collection (no address) */
function itemOf(entry, i, installedIds) {
  var key = 'a' + i,
    m = entry && entry.manifest,
    url = entry && typeof entry.transportUrl === 'string' ? entry.transportUrl : null,
    official = !!(entry && entry.flags && entry.flags.official),
    base = { key: key, name: (m && typeof m.name === 'string' ? m.name : 'An add-on').slice(0, 60), official: official, usable: false, checked: false };
  var address;
  try {
    address = stremio.addonUrl(url);
  } catch (e) {
    return { item: Object.assign(base, { reason: 'Its address isn\'t one Playpex can use' }) };
  }
  if (/^(127\.|localhost|10\.|192\.168\.|\[)/.test(address.host) || /^[\d.]+$/.test(address.host)) {
    return { item: Object.assign(base, { host: address.host, reason: 'It runs on that computer or network (Stremio\'s own local add-on)' }) };
  }
  var read;
  try {
    read = stremio.cleanManifest(m);
  } catch (e) {
    return { item: Object.assign(base, { host: address.host, reason: 'Its manifest isn\'t one Playpex can read' }) };
  }
  var made = manifests.synthesize(read.manifest, address, {}),
    id = made.manifest.id,
    offers = {
      play: made.playable.play,
      subtitles: made.playable.subtitles,
      catalogs: made.catalogs.length,
      titles: made.playable.meta
    },
    usable = made.playable.stream || made.playable.subtitles || made.catalogs.length > 0,
    installed = installedIds.indexOf(id) !== -1;
  return {
    url: address.manifest,
    item: Object.assign(base, {
      version: read.manifest.version,
      description: read.manifest.description ? read.manifest.description.slice(0, 300) : null,
      host: address.host,
      configured: address.configured,
      audience: read.manifest.behaviorHints.adults ? 'adults' : 'everyone',
      usable: usable,
      reason: usable ? null : 'It offers nothing Playpex can use',
      installed: installed ? id : null,
      checked: usable && !installed && DEFAULT_OFF.indexOf(read.manifest.id) === -1 && !official,
      offers: offers
    })
  };
}

function list(email, password) {
  if (typeof email !== 'string' || !/^\S+@\S+$/.test(email.trim()) || email.length > 200) {
    return Promise.reject(failure('INVALID', 'your Stremio account\'s e-mail'));
  }
  if (typeof password !== 'string' || !password || password.length > 500) {
    return Promise.reject(failure('INVALID', 'your Stremio account\'s password'));
  }
  var authKey = null;
  return api('login', { type: 'Login', email: email.trim(), password: password, facebook: false }).then(function (result) {
    authKey = result.authKey;
    if (typeof authKey !== 'string' || !authKey) {
      throw failure('UPSTREAM', 'Stremio gave no session');
    }
    return api('addonCollectionGet', { type: 'AddonCollectionGet', authKey: authKey, update: true });
  }).then(function (result) {
    var staged = stage(Array.isArray(result.addons) ? result.addons : []);
    log.info('Stremio import: ' + staged.addons.length + ' add-on(s) read from the account');
    return staged;
  }).then(function (answer) {
    return signOut(authKey).then(function () { return answer; });
  }, function (err) {
    return signOut(authKey).then(function () { throw err; });
  });
}

// Signed out before answering: Playpex keeps nothing of the account
function signOut(authKey) {
  return authKey ? api('logout', { type: 'Logout', authKey: authKey }).catch(function () {}) : Promise.resolve();
}

/** A collection (Stremio's or an addon_catalog's) as items, its addresses kept here for install() */
function stage(collection, options) {
  var installedIds = require('../index').all().map(function (p) { return p.id; });
  var addons = [], items = [], seen = {};
  collection.slice(0, ADDONS_MAX).forEach(function (entry, i) {
    if (entry && seen[entry.transportUrl]) {
      return;
    }
    seen[entry && entry.transportUrl] = true;
    var r = itemOf(entry, i, installedIds);
    // an add-on's list: nothing ticked, the admin chooses; a configured address there is someone else's
    // configuration (sometimes their key): never installed from a list
    if (options && options.listed) {
      r.item.checked = false;
      if (r.item.usable && r.item.configured) {
        r.item.usable = false;
        r.item.reason = 'Its address holds someone else\'s configuration: add it by its own address and configure it';
        r.url = null;
      }
    }
    items.push(r.item);
    addons.push({ key: r.item.key, url: r.url || null, name: r.item.name });
  });
  sweep();
  var id = crypto.randomBytes(16).toString('hex');
  sessions.set(id, { at: Date.now(), addons: addons });
  return { session: id, addons: items };
}

/** The add-ons a bridged add-on lists (its addon_catalogs), as an import offers them */
function listed(pluginId) {
  var plugin = require('../index').get(pluginId),
    bridge = require('./index');
  if (!plugin || plugin.trusted !== bridge.CODE) {
    return Promise.reject(failure('NOT_FOUND', 'No Stremio add-on ' + String(pluginId).slice(0, 40)));
  }
  return bridge.addonOf(plugin).then(function (a) {
    var cats = a.addon.addonCatalogs || [];
    if (!cats.length) {
      return { session: null, addons: [] };
    }
    var fetcher = require('./fetch');
    return Promise.all(cats.slice(0, 5).map(function (c) {
      return fetcher.get(plugin, a.address, 'addon_catalog', c.type, c.id).then(function (r) { return r.addons || []; }, function () { return []; });
    })).then(function (lists) {
      return stage([].concat.apply([], lists), { listed: true });
    });
  });
}

/** The chosen ones, one after another, each through the bridge's inspect → install */
function install(sessionId, keys) {
  sweep();
  var s = sessions.get(String(sessionId || ''));
  if (!s) {
    return Promise.reject(failure('NOT_FOUND', 'This import is no longer open: sign in to Stremio again'));
  }
  if (!Array.isArray(keys) || !keys.length) {
    return Promise.reject(failure('INVALID', 'keys: the add-ons to install'));
  }
  var managed = require('../managed'), pipeline = require('../install'),
    chosen = s.addons.filter(function (a) { return keys.indexOf(a.key) !== -1 && a.url; }),
    installed = [], failed = [];
  return chosen.reduce(function (chain, a) {
    return chain.then(function () {
      return managed.inspect('stremio', { url: a.url }).then(function (preview) {
        return pipeline.commit(preview.token, { accept: true }).then(function (r) {
          installed.push({ key: a.key, id: r.id || preview.id, name: preview.name });
        });
      }).catch(function (err) {
        failed.push({ key: a.key, name: a.name, error: err.message });
      });
    });
  }, Promise.resolve()).then(function () {
    sessions.delete(sessionId);
    log.info('Stremio import: ' + installed.length + ' installed, ' + failed.length + ' failed');
    return { installed: installed, failed: failed };
  });
}

function configure(options) {
  testing = Object.assign({ base: 'https://api.strem.io' }, options || {});
  sessions.clear();
}

module.exports = {
  list: list,
  listed: listed,
  install: install,
  configure: configure
};
