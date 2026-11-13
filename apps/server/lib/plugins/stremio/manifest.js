'use strict';

// A Stremio add-on's manifest → a Playpex plugin manifest
// (docs/stremio-bridge-plan.md §5.2, §8.1). Pure: no I/O.
//
//   synthesize(addon, address, { id?, icon }) → { manifest, catalogs, unused }
//     addon: the cleaned add-on manifest (@playpex/protocol/stremio#cleanManifest)
//     catalogs: [{ key, type, id, name, extra, placements, default, search }]   (also what stremio.addon answers)
//   idFor(addon, address) → 'st-torrentio-3fa1'
//   catalogKey(catalog) → 'c' + 8 hex: its setting's key, stable while its type and id are
//   playable(addon) → { play, subtitles, meta }   what the adapter's hooks may ask

var crypto = require('crypto'),
  stremio = require('@playpex/protocol/stremio');

var STOP_WORDS = ['com', 'org', 'net', 'io', 'app', 'dev', 'me', 'xyz', 'fun', 'stremio', 'strem', 'addon', 'addons', 'add', 'on',
  'community', 'plugin', 'github', 'www', 'v1', 'v2', 'v3', 'v4'];

function hash(text, n) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, n);
}

function idFor(addon, address) {
  var words = String(addon.id).toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w && STOP_WORDS.indexOf(w) === -1; }),
    slug = (words.join('-') || String(addon.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  if (!/^[a-z]/.test(slug)) {
    slug = 'a' + slug;
  }
  // another configuration of the same add-on is another plugin
  return 'st-' + slug.slice(0, 24) + '-' + hash(addon.id + '\n' + (address.configured ? address.base : ''), 4);
}

function catalogKey(c) {
  return 'c' + hash(c.type + '\n' + c.id, 8);
}

/** semver kept; "1.2" → 1.2.0, "v3" → 3.0.0, else 0.0.0 */
function versionOf(v) {
  if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) {
    return v;
  }
  var m = /(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?/.exec(v || '');
  return m ? [m[1], m[2] || '0', m[3] || '0'].map(function (x) { return String(parseInt(x, 10)); }).join('.') : '0.0.0';
}

function hasTt(addon, resource, types) {
  return addon.resources.some(function (r) {
    return r.name === resource && (!r.types.length || r.types.some(function (t) { return types.indexOf(t) !== -1; })) &&
      (!r.idPrefixes || !r.idPrefixes.length || r.idPrefixes.some(function (p) { return 'tt0000001'.indexOf(p) === 0 || p === 'tt'; }));
  });
}

function playable(addon) {
  var has = function (name) { return addon.resources.some(function (r) { return r.name === name; }); };
  return {
    play: hasTt(addon, 'stream', ['movie', 'series']),
    subtitles: hasTt(addon, 'subtitles', ['movie', 'series']),
    stream: has('stream'),
    meta: has('meta')
  };
}

var KNOWN_EXTRA = ['search', 'genre', 'skip'];

/** Where a catalog may show (§8.1): its choices and its default */
function placementsOf(c) {
  var required = c.extra.filter(function (e) { return e.isRequired; }).map(function (e) { return e.name; }),
    search = c.extra.some(function (e) { return e.name === 'search'; });
  if (required.some(function (n) {
    var e = c.extra.filter(function (x) { return x.name === n; })[0];
    return KNOWN_EXTRA.indexOf(n) === -1 && !(e && e.options.length);
  })) {
    return null;   // it needs something the bridge doesn't know how to give (a value with no options to pick from)
  }
  if (required.indexOf('search') !== -1) {
    return { placements: ['search', 'hidden'], default: 'search', search: true };
  }
  // a required genre: the first option asked
  var places = c.type === 'movie' ? ['movies', 'section', 'hidden'] : c.type === 'series' ? ['shows', 'section', 'hidden'] :
    c.type === 'anime' ? ['section', 'shows', 'hidden'] : ['section', 'hidden'];
  return { placements: places, default: places[0], search: search };
}

// Where its rows may go in section layouts (docs/rows-plan.md §4.2)
var ROW_SECTIONS = { movie: ['home', 'movies'], series: ['home', 'shows'], anime: ['home', 'shows'] };

/** A catalog's extras with options (a genre, a year…) as a row's params: [{ key, label, options, required }], and key → extra name */
function paramsOf(c) {
  var params = [], names = {};
  c.extra.forEach(function (e) {
    if (e.name === 'search' || e.name === 'skip' || !e.options.length || params.length >= 4) {
      return;
    }
    var key = String(e.name).replace(/[^A-Za-z0-9]/g, '').replace(/^[^a-zA-Z]+/, '').slice(0, 40);
    key = key && key.charAt(0).toLowerCase() + key.slice(1);
    if (!key || names[key]) {
      return;
    }
    var seen = {}, options = [];
    e.options.forEach(function (o) {
      if (!seen[o] && options.length < 200) {
        seen[o] = true;
        options.push([o, text(o, 60) || o.slice(0, 60)]);
      }
    });
    names[key] = e.name;
    params.push({ key: key, label: text(e.name.charAt(0).toUpperCase() + e.name.slice(1), 40), options: options, required: e.isRequired });
  });
  return { params: params, names: names };
}

/**
 * Its catalogs as rows offered to layouts: one per catalog that isn't search-only, joining the section its
 * "Show in" setting names (joinsSetting); a configured add-on's rows are personal (an account in its address)
 */
function offersOf(catalogs, address) {
  return catalogs.filter(function (c) {
    return c.placements.some(function (p) { return p !== 'search' && p !== 'hidden'; });
  }).slice(0, 200).map(function (c) {
    var p = paramsOf(c), offer = {
      key: c.key,
      title: text(c.name, 60),
      sections: ROW_SECTIONS[c.type] || ['home'],
      joinsSetting: c.key,
      data: 'row',
      args: { catalog: c.key, extras: p.names },
      personal: !!address.configured,
      candidates: true
    };
    if (p.params.length) {
      offer.params = p.params;
    }
    return offer;
  });
}

var PLACE_LABEL = { movies: 'Movies', shows: 'TV shows', section: 'Its own section', search: 'Search only', hidden: 'Hidden' };

// a plain mark for its menu entry and its page when it has no logo
var DEFAULT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z"/><path d="m10 9 5 3-5 3z" fill="#fff"/></svg>\n';

function text(s, max) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s;
}

/**
 * @param {object} addon cleaned add-on manifest
 * @param {object} address @playpex/protocol/stremio#addonUrl
 * @param {{ id?: string, icon?: string }} options icon: its asset path (else the default one is added)
 */
function synthesize(addon, address, options) {
  options = options || {};
  var can = playable(addon),
    unused = [],
    catalogs = [];
  addon.catalogs.forEach(function (c) {
    var p = stremio.TYPES.indexOf(c.type) === -1 ? null : placementsOf(c);
    if (!p) {
      unused.push('catalog ' + c.name + ' (' + c.type + ')');
      return;
    }
    catalogs.push(Object.assign({ key: catalogKey(c), type: c.type, id: c.id, name: c.name, extra: c.extra }, p));
  });
  if (addon.resources.some(function (r) { return r.name === 'addon_catalog'; }) && !(addon.addonCatalogs || []).length) {
    unused.push('addon_catalog');
  }
  addon.types.forEach(function (t) {
    if (stremio.TYPES.indexOf(t) === -1) {
      unused.push('type ' + t);
    }
  });
  var titles = can.meta || catalogs.length > 0,
    plays = can.stream || can.meta,
    hooks = [],
    settings = [],
    screens = [],
    slots = [],
    sections = [];
  if (can.play) {
    hooks.push('play.collect');
    settings.push({ key: 'play', scope: 'server', type: 'switch', label: 'Use for Play', default: true,
      description: 'Its streams and torrents in Play\'s chooser for movies and episodes' });
  }
  if (can.subtitles) {
    hooks.push('subtitles.providers');
    settings.push({ key: 'subtitles', scope: 'server', type: 'switch', label: 'Use for subtitles', default: true,
      description: 'Its subtitles in the player\'s list' });
  }
  // the dashboard's Search: its movie search catalog finds films, every bridged add-on's streams for them
  if (catalogs.some(function (c) { return c.search && c.type === 'movie'; })) {
    hooks.push('sources.search');
  }
  catalogs.forEach(function (c) {
    settings.push({
      key: c.key, scope: 'server', type: 'choice', group: 'Catalogs',
      label: text(c.name + ' (' + c.type + ')', 40),
      description: 'Where this catalog shows' + (c.search ? '; it also answers on the search page' : ''),
      options: c.placements.map(function (p) { return [p, PLACE_LABEL[p]]; }),
      default: c.default
    });
  });

  var icon = options.icon || 'assets/icon.svg';
  if (catalogs.some(function (c) { return c.placements.indexOf('section') !== -1; })) {
    screens.push({ name: 'home', template: 'catalog', data: 'home', title: text(addon.name, 40), mobile: { bar: 'fold' } });
    sections.push({ screen: 'home', menu: { label: text(addon.name, 20), icon: icon, order: 80 } });
  }
  if (titles) {
    screens.push({ name: 'title', template: 'title', data: 'title', params: ['type', 'id'] });
  }
  if (catalogs.some(function (c) { return c.placements.indexOf('movies') !== -1; })) {
    slots.push({ slot: 'core.movies.rows', data: 'movieRows', order: 50 });
  }
  if (catalogs.some(function (c) { return c.placements.indexOf('shows') !== -1; })) {
    slots.push({ slot: 'core.shows.rows', data: 'showRows', order: 50 });
  }
  if (catalogs.some(function (c) { return c.search; })) {
    slots.push({ slot: 'core.search.filters', data: 'searchChip', order: 50 });
  }
  var rows = offersOf(catalogs, address);

  var permissions = {};
  if (plays || titles) {
    permissions.network = [address.host];
  }
  if (plays) {
    permissions.sources = ['magnet', 'http', 'hls'].concat(titles ? ['embed'] : []);
  }
  if (titles && plays) {
    permissions.play = true;
  }
  if (hooks.length) {
    permissions.hooks = hooks;
  }

  var categories = [];
  if (can.stream) {
    categories.push('sources', 'streams');
  }
  if (can.subtitles) {
    categories.push('subtitles');
  }
  if (catalogs.length) {
    categories.push('catalog');
  }

  var contributes = {};
  if (sections.length) {
    contributes.sections = sections;
  }
  if (screens.length) {
    contributes.screens = screens;
  }
  if (slots.length) {
    contributes.slots = slots;
  }
  if (rows.length) {
    contributes.rows = rows;
  }
  if (settings.length) {
    contributes.settings = settings;
  }

  var manifest = {
    id: options.id || idFor(addon, address),
    name: text(addon.name, 40),
    description: text(addon.description || 'A Stremio add-on', 300),
    version: versionOf(addon.version),
    publisher: { name: text(address.host + ' (Stremio add-on)', 60) },
    api: { server: '^1.6' },
    audience: addon.behaviorHints.adults ? 'adults' : 'everyone',
    icon: icon,
    listing: {
      summary: text(addon.description || addon.name, 150),
      disclaimer: 'A Stremio add-on at ' + address.host + ' that Playpex talks to. It sees this server\'s address and the titles asked for; ' +
        'Playpex runs none of its code.',
      categories: categories.slice(0, 4)
    },
    permissions: permissions
  };
  if (Object.keys(contributes).length) {
    manifest.contributes = contributes;
  }
  return { manifest: manifest, catalogs: catalogs, unused: unused, playable: can, defaultIcon: options.icon ? null : DEFAULT_ICON };
}

module.exports = {
  synthesize: synthesize,
  idFor: idFor,
  catalogKey: catalogKey,
  versionOf: versionOf,
  playable: playable,
  DEFAULT_ICON: DEFAULT_ICON
};
