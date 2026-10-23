'use strict';

// What happened, for plugins (docs/plugins-plan.md §4.4): the core's own
// events (lib/events.js, read in-process with onPublish) turned into plugin
// events and delivered to the plugins that registered a handler for them
// (`playpex.events.on(name, fn)`), observe only.
//
//   playback.started / progress / paused / ended / finished   lib/sessions.js (internal), the player's keepalives
//   watchlist.added / removed, watched.set / cleared, rating.set   lib/services (internal), with `by`
//   download.added / completed / removed                      the torrent client's download.* events
//   library.changed                                           the library's, as the titles added / removed
//
// Rules: a plugin gets a family only with it in permissions.events; playback
// events of a profile only when the admin granted it `events.playback` for
// that profile; a kids profile's events never reach an `adults` plugin; a
// plugin's own writes never come back to it (`by: plugin:<id>`). Delivery is
// at most once, in order per plugin, through a queue of LIMITS.eventQueue:
// when it's full the oldest go and the next event delivered carries
// `dropped: n`. A failing handler is logged and counted, nothing more.

var protocol = require('@playpex/protocol/plugins'),
  events = require('../events'),
  userData = require('../userData'),
  changes = require('../services/changes'),
  log = require('../logger').child('plugins');

var FAMILY = { playback: 'playback', download: 'downloads', library: 'library', watchlist: 'watchlist', watched: 'watchlist', rating: 'watchlist' },
  DIRECT = ['playback.started', 'playback.progress', 'playback.paused', 'playback.ended', 'playback.finished',
    'watchlist.added', 'watchlist.removed', 'watched.set', 'watched.cleared', 'rating.set'],
  DONE = ['seeding', 'completed'],
  EVENT_TIMEOUT_MS = 10000,
  LIBRARY_DEBOUNCE_MS = 2000;

var plugins = null,          // ./index (set by start: it requires this module)
  started = false,
  queues = new Map(),        // plugin id → { items, dropped, running }
  grantsCache = new Map(),   // plugin id → Promise<{ profileId: [permission] }>
  profileCache = new Map(),  // profile id → Promise<{ id, kids } | null>
  downloads = new Map(),     // info hash → its last view (removed events name what went)
  library = null,            // Set of 'movie:<id>' / 'tv:<id>' known, null until read
  libraryTimer = null,
  chain = Promise.resolve(), // core events routed one after the other: order is kept
  options = { queue: protocol.LIMITS.eventQueue };

function services() {
  return userData.services();
}

function profileOf(id) {
  if (!id) {
    return Promise.resolve(null);
  }
  if (!profileCache.has(id)) {
    profileCache.set(id, services().then(function (s) { return s.profiles.get(id); }).then(function (p) {
      return { id: p.id, kids: !!p.isKid };
    }, function () {
      profileCache.delete(id);
      return null;
    }));
  }
  return profileCache.get(id);
}

function grantsOf(pluginId) {
  if (!grantsCache.has(pluginId)) {
    grantsCache.set(pluginId, services().then(function (s) { return s.plugins.grants.byProfile(pluginId); }).catch(function () {
      grantsCache.delete(pluginId);
      return {};
    }));
  }
  return grantsCache.get(pluginId);
}

/** A plugin's grants changed (the dashboard), or a profile did */
function invalidate(pluginId) {
  if (pluginId) {
    grantsCache.delete(pluginId);
  } else {
    grantsCache.clear();
    profileCache.clear();
  }
}

function stats(plugin) {
  plugin.stats.events = plugin.stats.events || { received: 0, dropped: 0, errors: 0 };
  return plugin.stats.events;
}

// ── delivery ────────────────────────────────────────────────────────────────

function pump(plugin) {
  var q = queues.get(plugin.id);
  if (!q || q.running || !q.items.length) {
    return;
  }
  var item = q.items.shift();
  if (q.dropped) {
    item.event.dropped = q.dropped;
    q.dropped = 0;
  }
  q.running = true;
  var current = plugins.get(plugin.id);
  var call = current && current.state === 'enabled' && current.sandbox
    ? current.sandbox.call('event', item.event.name, item.event, item.event.context, { timeoutMs: EVENT_TIMEOUT_MS })
    : Promise.resolve();
  call.then(function () {
    stats(plugin).received++;
  }, function (err) {
    stats(plugin).errors++;
    log.warn('plugin ' + plugin.id + ' event ' + item.event.name + ' failed: ' + err.message, { plugin: plugin.id, code: err.code });
  }).then(function () {
    q.running = false;
    pump(plugin);
  });
}

function enqueue(plugin, event) {
  var q = queues.get(plugin.id);
  if (!q) {
    q = { items: [], dropped: 0, running: false };
    queues.set(plugin.id, q);
  }
  if (q.items.length >= options.queue) {
    q.items.shift();
    q.dropped++;
    stats(plugin).dropped++;
  }
  q.items.push({ event: event });
  pump(plugin);
}

/**
 * One plugin event to whoever may see it: { name, data, profileId?, device?, by? }
 * (data without the profile; the context carries it)
 */
function deliver(e) {
  var family = FAMILY[e.name.split('.')[0]];
  var listeners = plugins.all().filter(function (p) {
    return p.state === 'enabled' && p.registered.event.indexOf(e.name) !== -1 &&
      (p.permissions.events || []).indexOf(family) !== -1 && e.by !== 'plugin:' + p.id;
  });
  if (!listeners.length) {
    return Promise.resolve();
  }
  return profileOf(e.profileId).then(function (profile) {
    if (e.profileId && !profile) {
      return;
    }
    return Promise.all(listeners.map(function (p) {
      if (profile && profile.kids && p.manifest.audience === 'adults') {
        return null;
      }
      var check = family === 'playback'
        ? grantsOf(p.id).then(function (g) { return (g[profile.id] || []).indexOf('events.playback') !== -1; })
        : Promise.resolve(true);
      return check.then(function (ok) {
        return ok ? p : null;
      });
    })).then(function (chosen) {
      var time = new Date().toISOString();
      chosen.filter(Boolean).forEach(function (p) {
        var event = {
          name: e.name,
          time: time,
          context: { profile: profile, device: e.device || null, locale: 'en' },
          data: e.data
        };
        if (e.by) {
          event.by = e.by;
        }
        enqueue(p, event);
      });
    });
  });
}

// ── the core's events ──────────────────────────────────────────────────────

function byOf(addedBy) {
  return typeof addedBy === 'string' && /^plugin:[a-z][a-z0-9-]{1,31}$/.test(addedBy) ? addedBy : 'user';
}

function downloadEvent(name, d) {
  return {
    name: name,
    profileId: d.profileId || null,
    by: byOf(d.addedBy),
    data: {
      title: d.title && d.title.tmdbId ? changes.titleRef(d.title) : null,
      name: d.name || d.infoHash,
      size: typeof d.sizeBytes === 'number' ? d.sizeBytes : null,
      state: d.state
    }
  };
}

// What's on the server, as titles (movies and shows), adults-only folders left out
function librarySet() {
  return services().then(function (s) {
    return require('../library/view').home(s, { kid: true });
  }).then(function (home) {
    var set = new Map();
    (home.movies || []).concat(home.shows || []).forEach(function (t) {
      set.set(t.mediaType + ':' + t.tmdbId, { mediaType: t.mediaType, tmdbId: t.tmdbId, title: t.title });
    });
    return set;
  });
}

function libraryChanged() {
  clearTimeout(libraryTimer);
  libraryTimer = setTimeout(function () {
    var before = library;
    librarySet().then(function (now) {
      library = now;
      if (!before) {
        return;
      }
      var added = [], removed = [];
      now.forEach(function (t, key) {
        if (!before.has(key)) {
          added.push(changes.titleRef(t));
        }
      });
      before.forEach(function (t, key) {
        if (!now.has(key)) {
          removed.push(changes.titleRef(t));
        }
      });
      if (added.length || removed.length) {
        route({ name: 'library.changed', data: { added: added.slice(0, 500), removed: removed.slice(0, 500) } });
      }
    }).catch(function (err) {
      log.warn('library.changed for plugins: ' + err.message);
    });
  }, LIBRARY_DEBOUNCE_MS);
}

function route(e) {
  chain = chain.then(function () { return deliver(e); }).catch(function (err) {
    log.warn('plugin event ' + e.name + ' not delivered: ' + err.message);
  });
  return chain;
}

function onCoreEvent(topic, data) {
  if (DIRECT.indexOf(topic) !== -1) {
    var payload = Object.assign({}, data);
    delete payload.profileId;
    delete payload.device;
    delete payload.by;
    return route({ name: topic, profileId: data.profileId, device: data.device || null, by: topic.indexOf('playback.') === 0 ? undefined : data.by, data: payload });
  }
  switch (topic) {
    case 'download.added':
      downloads.set(data.infoHash, data);
      return route(downloadEvent('download.added', data));
    case 'download.updated': {
      var before = downloads.get(data.infoHash);
      downloads.set(data.infoHash, data);
      if (before && DONE.indexOf(data.state) !== -1 && DONE.indexOf(before.state) === -1) {
        return route(downloadEvent('download.completed', data));
      }
      return;
    }
    case 'download.removed': {
      var known = downloads.get(data.infoHash);
      downloads.delete(data.infoHash);
      return route(downloadEvent('download.removed', known || { infoHash: data.infoHash, name: data.infoHash, state: 'removed' }));
    }
    case 'library.changed':
      return libraryChanged();
    case 'settings.changed':
    case 'profile.changed':
      profileCache.clear();
      return;
  }
}

/** From plugins/index start(): listens to the core's events (once) */
function start(index, opts) {
  plugins = index;
  options = Object.assign({ queue: protocol.LIMITS.eventQueue }, opts || {});
  if (started) {
    return;
  }
  started = true;
  events.onPublish(onCoreEvent);
  // the downloads and titles known now: later changes are told from them
  try {
    require('../torrents/client').list().forEach(function (d) { downloads.set(d.infoHash, d); });
  } catch (e) { /* no torrent client in this process */ }
  librarySet().then(function (set) { library = library || set; }).catch(function () {});
}

/** A plugin went (unload): its queue with it */
function forget(pluginId) {
  queues.delete(pluginId);
  grantsCache.delete(pluginId);
}

module.exports = {
  start: start,
  forget: forget,
  invalidate: invalidate,
  /** tests: wait until the events published so far were routed */
  settled: function () { return chain; }
};
