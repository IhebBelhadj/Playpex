'use strict';

// The code evaluated in each plugin's QuickJS context before its server.js
// (docs/plugins-plan.md §4.2): builds the `playpex` global over three native
// functions the worker hands in, and the dispatcher the worker calls handlers
// through. Runs inside the sandbox: plain ES2020, no Node, nothing of ours but
// these natives:
//
//   host(api, argsJson, bytes?) → Promise<[resultJson, bytes?]>   (rejects with { name, message, code })
//   register(kind, name) → '' or why it's refused                 (sync)
//   log(level, message, fieldsJson)                               (sync, fire and forget)
//
// and it returns dispatch(kind, name, argsJson, ctxJson) → Promise<resultJson>.

module.exports = String.raw`(function (host, register, log) {
  'use strict';
  var handlers = { hook: {}, data: {}, event: {}, job: {} };

  function call(api, args, bytes) {
    return host(api, JSON.stringify(args === undefined ? null : args), bytes).then(function (r) {
      var value = r[0] === undefined ? null : JSON.parse(r[0]);
      if (r[1] !== undefined) {
        var b = new Uint8Array(r[1]);
        if (value && typeof value === 'object' && value.body === '$bytes') {
          value.body = b;
        } else {
          value = b;
        }
      }
      return value;
    });
  }

  function add(kind, name, fn) {
    if (typeof name !== 'string' || typeof fn !== 'function') {
      throw new TypeError(kind + ': a name and a function');
    }
    var why = register(kind, name);
    if (why) {
      var err = new Error(why);
      err.name = 'PlaypexError';
      err.code = 'PERMISSION_DENIED';
      throw err;
    }
    handlers[kind][name] = fn;
  }

  function line(level) {
    return function (message, fields) {
      log(level, String(message), fields === undefined ? '' : JSON.stringify(fields));
    };
  }

  var playpex = {
    apiVersion: 1,
    http: {
      request: function (options) {
        if (!options || typeof options !== 'object') {
          return Promise.reject(new TypeError('http.request needs { url }'));
        }
        var copy = {}, bytes;
        Object.keys(options).forEach(function (k) { copy[k] = options[k]; });
        if (copy.body instanceof Uint8Array) {
          bytes = copy.body.buffer.slice(copy.body.byteOffset, copy.body.byteOffset + copy.body.byteLength);
          copy.body = '$bytes';
        } else if (copy.body instanceof ArrayBuffer) {
          bytes = copy.body;
          copy.body = '$bytes';
        }
        return call('http.request', copy, bytes);
      }
    },
    store: {
      get: function (key) { return call('store.get', { key: key }); },
      set: function (key, value) { return call('store.set', { key: key, value: value }); },
      delete: function (key) { return call('store.delete', { key: key }); },
      list: function (prefix) { return call('store.list', { prefix: prefix || '' }); }
    },
    secrets: {
      get: function (name) { return call('secrets.get', { name: name }); }
    },
    settings: {
      get: function (key, ctx) {
        return call('settings.get', { key: key, profileId: ctx && ctx.profile ? ctx.profile.id : null });
      }
    },
    i18n: {
      t: function (key, vars, ctx) {
        return call('i18n.t', { key: key, vars: vars || null, locale: ctx && ctx.locale || null });
      }
    },
    tmdb: {
      get: function (path, params) { return call('tmdb.get', { path: path, params: params || null }); },
      movie: function (id, params) { return playpex.tmdb.get('/movie/' + id, params); },
      tv: function (id, params) { return playpex.tmdb.get('/tv/' + id, params); },
      season: function (id, season, params) { return playpex.tmdb.get('/tv/' + id + '/season/' + season, params); },
      episode: function (id, season, episode, params) {
        return playpex.tmdb.get('/tv/' + id + '/season/' + season + '/episode/' + episode, params);
      },
      person: function (id, params) { return playpex.tmdb.get('/person/' + id, params); },
      search: function (kind, query, params) { return playpex.tmdb.get('/search/' + kind, Object.assign({ query: query }, params)); },
      discover: function (kind, params) { return playpex.tmdb.get('/discover/' + kind, params); },
      trending: function (kind, window, params) { return playpex.tmdb.get('/trending/' + (kind || 'all') + '/' + (window || 'week'), params); },
      find: function (externalId, source, params) {
        return playpex.tmdb.get('/find/' + externalId, Object.assign({ external_source: source || 'imdb_id' }, params));
      },
      image: function (path, size) { return path ? 'https://image.tmdb.org/t/p/' + (size || 'w342') + path : null; }
    },
    imdb: {
      title: function (id) { return call('imdb.title', { id: id }); },
      episodes: function (id) { return call('imdb.episodes', { id: id }); }
    },
    library: {
      find: function (title, ctx) { return call('library.find', { title: title, profileId: ctx && ctx.profile ? ctx.profile.id : null }); }
    },
    names: {
      parse: function (name) { return call('names.parse', { name: name }); },
      describe: function (name) { return call('names.describe', { name: name }); },
      matches: function (name, title) { return call('names.matches', { name: name, title: title }); },
      rank: function (items) { return call('names.rank', { items: items }); }
    },
    html: {
      select: function (html, selector, fields) { return call('html.select', { html: html, selector: selector, fields: fields || null }); }
    },
    torrent: {
      info: function (bytes) {
        var b = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) :
          bytes instanceof ArrayBuffer ? bytes : null;
        if (!b) {
          return Promise.reject(new TypeError('torrent.info needs a Uint8Array or an ArrayBuffer'));
        }
        return call('torrent.info', {}, b);
      }
    },
    log: { info: line('info'), warn: line('warn'), error: line('error') },
    hooks: { on: function (name, fn) { add('hook', name, fn); } },
    events: { on: function (name, fn) { add('event', name, fn); } },
    schedule: {
      every: function (name, interval, fn, options) {
        add('job', name, fn);
        return call('schedule.every', { name: name, interval: interval, options: options || null });
      },
      cancel: function (name) {
        delete handlers.job[name];
        return call('schedule.cancel', { name: name });
      }
    },
    data: function (name, fn) { add('data', name, fn); },
    notify: { send: function (profiles, message) { return call('notify.send', { profiles: profiles, message: message }); } },
    plugins: {
      call: function (id, name, args, options) {
        options = options || {};
        return call('plugins.call', { id: id, name: name, args: args === undefined ? null : args, profileId: options.profileId || null, locale: options.locale || null });
      }
    },
    link: {
      status: function (name, profileId) { return call('link.status', { name: name, profileId: profileId || null }); }
    },
    watchlist: {
      add: function (profileId, title) { return call('watchlist.add', { profileId: profileId, title: title }); },
      remove: function (profileId, title) { return call('watchlist.remove', { profileId: profileId, title: title }); },
      list: function (profileId) { return call('watchlist.list', { profileId: profileId }); }
    },
    watched: {
      set: function (profileId, title, options) { return call('watched.set', { profileId: profileId, title: title, options: options || null }); },
      clear: function (profileId, title) { return call('watched.clear', { profileId: profileId, title: title }); }
    },
    progress: {
      set: function (profileId, title, position, duration, options) {
        return call('progress.set', { profileId: profileId, title: title, position: position, duration: duration, options: options || null });
      }
    },
    ratings: {
      set: function (profileId, title, value) { return call('ratings.set', { profileId: profileId, title: title, value: value }); },
      clear: function (profileId, title) { return call('ratings.clear', { profileId: profileId, title: title }); }
    },
    profiles: {
      list: function (permission) { return call('profiles.list', { permission: permission || null }); }
    },
    downloads: {
      add: function (request) { return call('downloads.add', request); },
      list: function () { return call('downloads.list', {}); }
    }
  };
  Object.freeze(playpex);
  Object.defineProperty(globalThis, 'playpex', { value: playpex, enumerable: true });

  // The worker's way in: one handler call, its answer as JSON (undefined → null)
  return function dispatch(kind, name, argsJson, ctxJson) {
    var fn = handlers[kind] && handlers[kind][name];
    if (!fn) {
      return Promise.reject(Object.assign(new Error('no ' + kind + ' handler ' + name), { code: 'NO_HANDLER' }));
    }
    var ctx = JSON.parse(ctxJson);
    if (ctx) {
      Object.freeze(ctx);
    }
    return Promise.resolve().then(function () {
      return fn(JSON.parse(argsJson), ctx);
    }).then(function (result) {
      return result === undefined ? 'null' : JSON.stringify(result);
    });
  };
})`;
