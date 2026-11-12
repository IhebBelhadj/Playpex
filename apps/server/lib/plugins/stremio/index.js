'use strict';

// The Stremio add-on bridge (docs/stremio-bridge-plan.md): each add-on is a
// managed plugin (../managed, provider `stremio`) whose manifest is built from
// the add-on's (./manifest.js) and whose code is the adapter the server ships
// (../builtin/stremio/server.js). The add-on's URL is the plugin's input, kept
// as a secret (it may hold a debrid key): the adapter never sees it. The
// adapter reads the add-on only through these core-only host calls:
//
//   stremio.addon ()                     → { name, host, catalogs: [{ key, type, id, name, extra, search, show }], play, subtitles,
//                                            stream, meta }   (show: the admin's placement of each catalog)
//   stremio.get ({ resource, type, id, extra? })   → the cleaned answer (@playpex/protocol/stremio#clean); a catalog's metas with
//                                            tmdbId where TMDB knows their IMDb id
//   stremio.streams ({ type, id })        → { streams: [stream + { addon }], errors }   every bridged add-on that answers streams
//                                            for that id (a Kitsu title page asks Torrentio too)
//
// Every answer teaches ../grants.js the hosts it names (decision B): its https
// stream and subtitle URLs (scope stream: a source's bytes, never the
// plugin's own requests) and its pictures (scope image, ../images.js).

var http = require('../http'),
  grants = require('../grants'),
  managed = require('../managed'),
  corecalls = require('../corecalls'),
  stremio = require('@playpex/protocol/stremio'),
  fetcher = require('./fetch'),
  manifests = require('./manifest'),
  tmdb = require('../../tmdb'),
  userData = require('../../userData');

var CODE = 'stremio',
  LOGO_MAX = 256 * 1024,
  TMDB_LOOKUPS = 60,
  TMDB_KEPT = 20000;

var addresses = new WeakMap(),     // plugin → Promise<address>
  tmdbIds = new Map();             // imdb id → { tmdbId, kind } | null

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

// ── the provider ────────────────────────────────────────────────────────────

function sniffImage(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

/** The add-on's logo as the plugin's icon (once, at build): png / jpeg / webp, ≤ 256 KB; else null */
function logoOf(owner, url) {
  if (!url) {
    return Promise.resolve(null);
  }
  return http.request({ id: owner.id, permissions: { network: [] }, anyHost: true }, { url: url, responseType: 'bytes', timeoutMs: 5000 }).then(function (r) {
    var bytes = r.bytes, kind = r.value.status === 200 && bytes && bytes.length <= LOGO_MAX ? sniffImage(bytes) : null;
    return kind ? { path: 'assets/icon.' + kind, bytes: bytes } : null;
  }).catch(function () { return null; });
}

function inputUrl(input) {
  var url = input && typeof input === 'object' ? input.url : input;
  if (typeof url !== 'string' || !url.trim()) {
    throw failure('INVALID', 'paste the add-on\'s manifest URL');
  }
  return stremio.addonUrl(url);
}

/**
 * input { url } → its plugin. `current`: the installed manifest (an update or a
 * new configuration of it: it keeps its id, and must be the same add-on)
 */
function build(input, current) {
  var address;
  try {
    address = inputUrl(input);
  } catch (err) {
    return Promise.reject(err);
  }
  if (/^[\d.]+$|:/.test(address.host)) {
    return Promise.reject(failure('INVALID', 'add-ons on an IP address aren\'t supported: use its host name'));
  }
  var owner = { id: current ? current.id : 'stremio', manifest: { name: 'Stremio add-on' }, stats: { host: {} } };
  return fetcher.manifest(owner, address, { fresh: true }).then(function (read) {
    var addon = read.manifest, id = manifests.idFor(addon, address);
    if (current) {
      var slug = id.replace(/-[0-9a-f]{4}$/, '');
      if (current.id.replace(/-[0-9a-f]{4}$/, '') !== slug) {
        throw failure('INVALID', 'that is another add-on (' + addon.name + '): add it as another plugin');
      }
      id = current.id;
    }
    return logoOf(owner, addon.logo).then(function (logo) {
      var made = manifests.synthesize(addon, address, { id: id, icon: logo ? logo.path : null }),
        assets = {};
      if (logo) {
        assets[logo.path] = logo.bytes;
      } else {
        assets['assets/icon.svg'] = Buffer.from(made.defaultIcon, 'utf8');
      }
      if (!made.playable.stream && !made.playable.subtitles && !made.catalogs.length) {
        throw failure('INVALID', addon.name + ' offers nothing Playpex can use (' +
          (read.unused.concat(made.unused).join(', ') || 'no streams, subtitles or catalogs') + ')');
      }
      return {
        manifest: made.manifest,
        assets: assets,
        summary: {
          addon: { id: addon.id, name: addon.name, version: addon.version, description: addon.description },
          host: address.host,
          configured: address.configured,
          configureUrl: addon.behaviorHints.configurable && !address.configured ? address.base + '/configure' : null,
          configurationRequired: addon.behaviorHints.configurationRequired && !address.configured,
          audience: addon.behaviorHints.adults ? 'adults' : 'everyone',
          p2p: addon.behaviorHints.p2p,
          offers: {
            play: made.playable.play,
            ownStreams: made.playable.stream && !made.playable.play,
            subtitles: made.playable.subtitles,
            catalogs: made.catalogs.map(function (c) { return { name: c.name, type: c.type, show: c.default }; }),
            titles: made.playable.meta,
            addons: (addon.addonCatalogs || []).length > 0
          },
          unused: read.unused.concat(made.unused)
        }
      };
    });
  });
}

// ── the core calls ──────────────────────────────────────────────────────────

function addressOf(plugin) {
  var known = addresses.get(plugin);
  if (!known) {
    known = managed.inputOf(plugin.id).then(function (input) {
      if (!input) {
        throw failure('NOT_RUNNING', 'this add-on has no address (install it again)');
      }
      return inputUrl(input);
    });
    known.catch(function () { addresses.delete(plugin); });
    addresses.set(plugin, known);
  }
  return known;
}

function bridged(plugin) {
  if (plugin.trusted !== CODE) {
    throw failure('PERMISSION_DENIED', 'stremio.* is the Stremio bridge\'s');
  }
}

/** Hosts an answer names, learned for the plugin that will play or show them */
function learnFrom(plugin, answer) {
  var streams = [], images = [];
  (answer.streams || []).forEach(function (s) {
    if (s.url && /^https:/i.test(s.url)) {
      streams.push(s.url);
    }
    // an archive's parts (https only: archiveOf refuses the others)
    ((s.archive && s.archive.parts) || []).forEach(function (p) { streams.push(p.url); });
  });
  (answer.subtitles || []).forEach(function (s) {
    streams.push(s.url);
  });
  (answer.metas || []).concat(answer.meta ? [answer.meta] : []).forEach(function (m) {
    [m.poster, m.background, m.logo].forEach(function (u) {
      if (u) {
        images.push(u);
      }
    });
    (m.videos || []).forEach(function (v) {
      if (v.thumbnail) {
        images.push(v.thumbnail);
      }
    });
  });
  if (streams.length) {
    grants.learn(plugin, null, streams, { scope: 'stream', from: 'answer' });
  }
  if (images.length) {
    grants.learn(plugin, null, images, { scope: 'image', from: 'answer' });
  }
}

/** TMDB ids of the metas TMDB knows by IMDb id (cached; at most 60 lookups per answer) */
function withTmdb(metas) {
  var todo = metas.filter(function (m) { return m.imdbId && !m.tmdbId && !tmdbIds.has(m.imdbId); }).slice(0, TMDB_LOOKUPS),
    i = 0;
  function next() {
    var m = todo[i++];
    if (!m) {
      return Promise.resolve();
    }
    return tmdb.find(m.imdbId).then(function (r) {
      var movie = (r && r.movie_results || [])[0], tv = (r && r.tv_results || [])[0];
      tmdbIds.set(m.imdbId, movie ? { tmdbId: movie.id, kind: 'movie' } : tv ? { tmdbId: tv.id, kind: 'show' } : null);
    }, function () {}).then(function () {
      if (tmdbIds.size > TMDB_KEPT) {
        tmdbIds.delete(tmdbIds.keys().next().value);
      }
      return next();
    });
  }
  return Promise.all([next(), next(), next(), next()]).then(function () {
    return metas.map(function (m) {
      var known = m.imdbId ? tmdbIds.get(m.imdbId) : null;
      if (m.tmdbId) {
        return Object.assign({}, m, { tmdbKind: m.type === 'movie' ? 'movie' : 'show' });
      }
      return known ? Object.assign({}, m, { tmdbId: known.tmdbId, tmdbKind: known.kind }) : m;
    });
  });
}

function addonOf(plugin) {
  return addressOf(plugin).then(function (address) {
    return fetcher.manifest(plugin, address).then(function (read) {
      return { address: address, addon: read.manifest };
    });
  });
}

function settingsOf(plugin) {
  return userData.services().then(function (s) {
    return s.plugins.settings.values(plugin.id, (plugin.manifest.contributes && plugin.manifest.contributes.settings) || [], null);
  }).then(function (v) { return v.server; });
}

function addonCall(plugin) {
  bridged(plugin);
  return Promise.all([addonOf(plugin), settingsOf(plugin)]).then(function (r) {
    var addon = r[0].addon, values = r[1],
      made = manifests.synthesize(addon, r[0].address, { id: plugin.id }),
      // the catalogs its manifest has settings for (an add-on that changed: until it is rebuilt)
      known = ((plugin.manifest.contributes && plugin.manifest.contributes.settings) || []).map(function (d) { return d.key; });
    return {
      id: plugin.id,
      name: plugin.manifest.name,
      host: r[0].address.host,
      play: made.playable.play && values.play !== false,
      subtitles: made.playable.subtitles && values.subtitles !== false,
      stream: made.playable.stream,
      meta: made.playable.meta,
      catalogs: made.catalogs.filter(function (c) { return known.indexOf(c.key) !== -1; }).map(function (c) {
        var show = values[c.key];
        return { key: c.key, type: c.type, id: c.id, name: c.name, search: c.search, show: c.placements.indexOf(show) !== -1 ? show : c.default,
          genres: ((c.extra.filter(function (e) { return e.name === 'genre'; })[0] || {}).options || []).slice(0, 40),
          genreRequired: c.extra.some(function (e) { return e.name === 'genre' && e.isRequired; }),
          paged: c.extra.some(function (e) { return e.name === 'skip'; }) };
      })
    };
  });
}

function getCall(plugin, args) {
  bridged(plugin);
  var resource = String(args.resource || '');
  if (stremio.RESOURCES.indexOf(resource) === -1) {
    return Promise.reject(failure('INVALID', 'resource: one of ' + stremio.RESOURCES.join(', ')));
  }
  return addonOf(plugin).then(function (a) {
    if (!stremio.offers(a.addon, resource, String(args.type || ''), String(args.id || ''))) {
      return stremio.empty(resource);
    }
    return fetcher.get(plugin, a.address, resource, args.type, args.id, args.extra).then(function (answer) {
      learnFrom(plugin, answer);
      if (resource === 'catalog') {
        return withTmdb(answer.metas).then(function (metas) { return Object.assign({}, answer, { metas: metas }); });
      }
      if (resource === 'meta' && answer.meta) {
        return withTmdb([answer.meta]).then(function (m) { return Object.assign({}, answer, { meta: m[0] }); });
      }
      return answer;
    });
  });
}

/** Every bridged add-on's streams for an id: the caller plays them (their hosts learned for it) */
function streamsCall(plugin, args) {
  bridged(plugin);
  var type = String(args.type || ''), id = String(args.id || ''),
    all = require('../index').all().filter(function (p) {
      return p.trusted === CODE && p.state === 'enabled' && (p.manifest.permissions.sources || []).length;
    });
  return Promise.all(all.map(function (p) {
    return addonOf(p).then(function (a) {
      // its own type for the id, else any it answers streams for (Kitsu says series, Torrentio anime)
      var types = a.addon.resources.filter(function (r) { return r.name === 'stream'; }).reduce(function (t, r) { return t.concat(r.types); }, []),
        asked = types.indexOf(type) !== -1 || !types.length ? type : ['series', 'anime', 'movie'].filter(function (t) { return types.indexOf(t) !== -1; })[0];
      if (!asked || !stremio.offers(a.addon, 'stream', asked, id)) {
        return null;
      }
      return fetcher.get(p, a.address, 'stream', asked, id).then(function (answer) {
        learnFrom(plugin, answer);
        if (p !== plugin) {
          learnFrom(p, answer);
        }
        return { addon: p.manifest.name, streams: answer.streams };
      });
    }).catch(function (err) {
      return { addon: p.manifest.name, error: err.message };
    });
  })).then(function (answers) {
    var streams = [], errors = [];
    answers.filter(Boolean).forEach(function (a) {
      if (a.error) {
        errors.push(a.addon + ': ' + a.error);
      } else {
        a.streams.forEach(function (s) { streams.push(Object.assign({ addon: a.addon }, s)); });
      }
    });
    return { streams: streams.slice(0, stremio.LIMITS.streams), errors: errors };
  });
}

var registered = false;

function register() {
  if (registered) {
    return;
  }
  registered = true;
  corecalls.register('stremio.addon', addonCall);
  corecalls.register('stremio.get', getCall);
  corecalls.register('stremio.streams', streamsCall);
  managed.register({ name: 'stremio', label: 'Stremio add-on', code: CODE, secretInput: true, build: build });
}

/** A plugin that goes (removed, reloaded with a new address): its answers forgotten */
function forget(id) {
  fetcher.forget(id);
}

register();

module.exports = {
  register: register,
  addonOf: addonOf,
  build: build,
  forget: forget,
  CODE: CODE,
  testing: { tmdbIds: tmdbIds, configure: fetcher.configure }
};

