'use strict';

// Section rows (docs/rows-plan.md §3–§4, §7): a profile's layout resolved into
// the rows clients draw, and each row's pages.
//
//   resolve(section, ctx)            → { section, rows: [ResolvedRow] }
//   items(section, rowId, page, ctx) → { id, kind, items, last, title?, plugin? }
//   sources(ctx)                     → what the row editors can add: the core's sources, plugins' offers
//
// ctx: { profile: { id, kids } | null, device: { id, name }, locale }
//
// A layout's entries (lib/services/layouts.js) become rows:
//   - plugins offering rows that join this section and that the layout hasn't
//     known yet join at the end as one `plugin.all` entry each (`new: true`)
//   - `plugin.all` expands to the plugin's offers joining this section and not
//     placed on their own, or (a plugin with only the old slots) its slot's rows
//   - `core.because` expands to one row per strongest seed
//   - personal rows with nothing in them, rows of plugins the profile can't see,
//     and plugin rows whose offer is gone are left out
// A row's id is its entry's, plus `~<part>` for an expansion (r_abc~c1a2b3c4d,
// r_abc~m27205), so the items route finds it again from the layout alone.

var crypto = require('crypto'),
  rows = require('@playpex/protocol/rows'),
  plugins = require('../plugins'),
  images = require('../plugins/images'),
  catalog = require('../catalog'),
  userData = require('../userData'),
  libraryView = require('../library/view'),
  log = require('../logger').child('rows');

var LEGACY_SLOTS = { movies: 'core.movies.rows', shows: 'core.shows.rows' },
  KID_GENRES = [16, 10751, 10762],
  PERSONAL_LIMIT = 40,
  CACHE_MS = 2 * 60 * 1000,
  CACHE_MAX = 500,
  DAY_MS = 24 * 60 * 60 * 1000;

var cache = new Map();   // plugin answers: key → { at, value }

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  err.status = code === 'NOT_FOUND' ? 404 : code === 'INVALID' ? 400 : 502;
  err.name = 'ServiceError';
  return err;
}

function hash(text, n) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, n);
}

function cached(key, work) {
  var hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return hit.value;
  }
  var value = work();
  cache.set(key, { at: Date.now(), value: value });
  value.catch(function () { cache.delete(key); });
  if (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  return value;
}

// ── plugins and their offers ────────────────────────────────────────────────

function visible(ctx) {
  return plugins.all().filter(function (p) {
    return p.state === 'enabled' && !plugins.blocked(p, ctx);
  });
}

function pluginOf(id, ctx) {
  var p = plugins.get(id);
  return p && p.state === 'enabled' && !plugins.blocked(p, ctx) ? p : null;
}

/** A plugin's declared offers (contributes.rows) */
function offersOf(plugin) {
  var c = plugin.manifest.contributes || {};
  return (c.rows || []).map(function (o) {
    return Object.assign({ joins: [], params: [], args: {} }, o, { title: plugins.localize(plugin, o.title, 'en') });
  });
}

/** The old slot contribution of a plugin without offers, for a section, or null */
function legacySlot(plugin, section) {
  var c = plugin.manifest.contributes || {};
  if ((c.rows || []).length || !LEGACY_SLOTS[section]) {
    return null;
  }
  return (c.slots || []).filter(function (s) { return s.slot === LEGACY_SLOTS[section]; })[0] || null;
}

/**
 * Its offers with where they join now: an offer's `joinsSetting` names a server
 * choice setting whose value is the section (a Stremio catalog's placement)
 */
function effectiveOffers(plugin) {
  var offers = offersOf(plugin);
  if (!offers.some(function (o) { return o.joinsSetting; })) {
    return Promise.resolve(offers);
  }
  var defs = (plugin.manifest.contributes && plugin.manifest.contributes.settings) || [];
  return userData.services().then(function (s) {
    return s.plugins.settings.values(plugin.id, defs, null);
  }).then(function (values) {
    return (values && values.server) || {};
  }, function () { return {}; }).then(function (server) {
    return offers.map(function (o) {
      if (!o.joinsSetting) {
        return o;
      }
      var place = server[o.joinsSetting];
      return Object.assign({}, o, { joins: o.sections.indexOf(place) !== -1 ? [place] : [] });
    });
  });
}

/** Every visible plugin's offers as they join now: { pluginId: offers } */
function offersNow(ctx) {
  var list = visible(ctx);
  return Promise.all(list.map(effectiveOffers)).then(function (all) {
    return list.reduce(function (map, p, i) {
      map[p.id] = all[i];
      return map;
    }, {});
  });
}

function joins(plugin, section, offers) {
  return (offers[plugin.id] || []).some(function (o) { return o.joins.indexOf(section) !== -1; }) || !!legacySlot(plugin, section);
}

function profileKey(ctx) {
  return (ctx.profile && ctx.profile.id) || '-';
}

function callData(plugin, name, args, ctx, personal) {
  var key = [plugin.id, plugin.manifest.version, name, JSON.stringify(args), personal ? profileKey(ctx) : '', ctx.profile && ctx.profile.kids ? 'k' : ''].join('\n');
  return cached(key, function () {
    return plugins.data(plugin.id, name, args, ctx).then(function (answer) {
      return images.rewrite(plugin, answer.data);
    });
  });
}

/** The old slot's rows (each with items or a page call), cached */
function legacyRows(plugin, section, ctx) {
  var slot = legacySlot(plugin, section);
  if (!slot) {
    return Promise.resolve([]);
  }
  // slot answers can depend on the profile (Trakt's): cached per profile
  return callData(plugin, slot.data, {}, ctx, true).then(function (data) {
    return Array.isArray(data) ? data : [];
  }, function (err) {
    log.warn('plugin ' + plugin.id + ' rows for ' + section + ': ' + err.message);
    return [];
  });
}

// ── what a profile has watched ──────────────────────────────────────────────

function titleKey(mediaType, tmdbId) {
  return mediaType + ':' + tmdbId;
}

function watchedSet(ctx) {
  if (!ctx.profile) {
    return Promise.resolve(new Set());
  }
  return userData.services().then(function (s) {
    return s.playback.watchedTitles(ctx.profile.id, { limit: 200 });
  }).then(function (list) {
    return new Set(list.map(function (t) { return titleKey(t.mediaType, t.tmdbId); }));
  }, function () { return new Set(); });
}

/** A card's core title, when it opens one: 'movie:27205' */
function cardTitle(card) {
  var intent = card && card.intent, id = intent && intent.params && Number(intent.params.id);
  if (!intent || !id) {
    return null;
  }
  return intent.screen === 'core.movie' ? titleKey('movie', id) : intent.screen === 'core.show' ? titleKey('tv', id) : null;
}

function kidsKeep(ctx) {
  return function (t) {
    return !(ctx.profile && ctx.profile.kids) || (t.genreIds || []).some(function (g) { return KID_GENRES.indexOf(g) !== -1; });
  };
}

// ── the layout's entries ────────────────────────────────────────────────────

function joinId(pluginId) {
  return 'r_j' + hash(pluginId, 10);
}

/** The layout's entries plus the plugins joining it (new: true) */
function entriesOf(section, ctx) {
  return Promise.all([userData.services().then(function (s) {
    return ctx.profile ? s.layouts.get(ctx.profile.id, section) : s.layouts.getDefault(section);
  }), offersNow(ctx)]).then(function (got) {
    var layout = got[0], offers = got[1];
    var placed = {};
    layout.rows.forEach(function (e) {
      if (rows.isPlugin(e.source)) {
        placed[e.params.plugin] = true;
      }
    });
    var joined = visible(ctx).filter(function (p) {
      return layout.known.indexOf(p.id) === -1 && !placed[p.id] && joins(p, section, offers);
    }).map(function (p) {
      return { id: joinId(p.id), source: 'plugin.all', params: { plugin: p.id }, new: true };
    });
    return { layout: layout, entries: layout.rows.concat(joined), offers: offers };
  });
}

function mediaTypeOf(entry, section) {
  var m = entry.params && entry.params.mediaType;
  return m || (section === 'movies' ? 'movie' : section === 'shows' ? 'tv' : null);
}

/** Offers of plugin.all for this section: joining it, not placed on their own in the layout */
function groupOffers(plugin, section, entries, offers) {
  var single = {};
  entries.forEach(function (e) {
    if (e.source === 'plugin' && e.params.plugin === plugin.id) {
      single[e.params.row] = true;
    }
  });
  return (offers[plugin.id] || []).filter(function (o) {
    return o.joins.indexOf(section) !== -1 && !single[o.key];
  }).slice(0, rows.LIMITS.expanded);
}

function base(entry, extra) {
  return Object.assign({
    id: entry.id,
    entry: entry.id,
    source: entry.source,
    title: entry.title || rows.defaultTitle(entry),
    variant: entry.variant || 'poster',
    kind: 'titles',
    personal: !!(rows.source(entry.source) || {}).personal
  }, entry.new ? { new: true } : {}, extra);
}

function offerRow(entry, plugin, offer, id) {
  return base(entry, {
    id: id,
    title: (entry.source === 'plugin' && entry.title) || offer.title,
    variant: entry.variant || offer.variant || 'poster',
    kind: 'cards',
    plugin: plugin.id,
    offer: offer.key,
    personal: !!offer.personal
  });
}

function legacyRow(entry, plugin, row) {
  var out = base(entry, {
    id: entry.id + '~s' + hash(row.key, 8),
    title: row.title,
    variant: row.variant || 'poster',
    kind: 'cards',
    plugin: plugin.id,
    personal: false
  });
  if (row.items) {
    out.items = row.items;
    out.last = true;
  }
  return out;
}

// Personal core rows: their items now (left out when empty)
function personalItems(entry, section, ctx) {
  var mediaType = mediaTypeOf(entry, section), profileId = ctx.profile.id;
  return userData.services().then(function (s) {
    switch (entry.source) {
      case 'core.continue':
        return s.playback.continueWatching(profileId, { limit: PERSONAL_LIMIT });
      case 'core.watchlist':
        return s.watchlist.list(profileId, { limit: 200 });
      case 'core.forYou':
        return s.recommendations.forProfile(profileId, { mediaType: mediaType || undefined, limit: PERSONAL_LIMIT }).then(function (r) { return r.items; });
      default:
        return [];
    }
  }).then(function (items) {
    return items.filter(function (t) { return !mediaType || t.mediaType === mediaType; });
  });
}

function becauseRows(entry, section, ctx) {
  return userData.services().then(function (s) {
    return s.recommendations.because(ctx.profile.id, { mediaType: mediaTypeOf(entry, section) || undefined, count: entry.params.count || 1, limit: PERSONAL_LIMIT });
  });
}

function seedPart(seed) {
  return (seed.mediaType === 'movie' ? 'm' : 't') + seed.tmdbId;
}

function libraryItems(entry, section, ctx) {
  var mediaType = mediaTypeOf(entry, section);
  return userData.services().then(function (s) {
    return libraryView.home(s, { kid: !!(ctx.profile && ctx.profile.kids) });
  }).then(function (home) {
    var list = home.movies.concat(home.shows).filter(function (t) { return !mediaType || t.mediaType === mediaType; });
    if (entry.params.order === 'title') {
      return list.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
    }
    return list.sort(function (a, b) { return a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0; });
  });
}

/** One entry → its rows (0, 1 or several) */
function expand(entry, section, entries, offers, ctx) {
  var personal = (rows.source(entry.source) || {}).personal;
  if (personal && !ctx.profile) {
    return Promise.resolve([]);
  }
  if (entry.source === 'plugin') {
    var plugin = pluginOf(entry.params.plugin, ctx),
      offer = plugin && offersOf(plugin).filter(function (o) { return o.key === entry.params.row; })[0];
    if (!offer || offer.sections.indexOf(section) === -1) {
      return Promise.resolve([]);
    }
    return Promise.resolve([offerRow(entry, plugin, offer, entry.id)]);
  }
  if (entry.source === 'plugin.all') {
    var p = pluginOf(entry.params.plugin, ctx);
    if (!p) {
      return Promise.resolve([]);
    }
    if (legacySlot(p, section)) {
      return legacyRows(p, section, ctx).then(function (list) {
        return list.slice(0, rows.LIMITS.expanded).map(function (r) { return legacyRow(entry, p, r); });
      });
    }
    return Promise.resolve(groupOffers(p, section, entries, offers).map(function (o) {
      return offerRow(entry, p, o, entry.id + '~' + o.key);
    }));
  }
  if (entry.source === 'core.because') {
    return becauseRows(entry, section, ctx).then(function (list) {
      return list.map(function (b) {
        return base(entry, {
          id: entry.id + '~' + seedPart(b.seed),
          title: 'Because you watched ' + b.seed.title,
          because: b.seed,
          items: b.items,
          last: true
        });
      });
    });
  }
  if (personal) {
    return personalItems(entry, section, ctx).then(function (items) {
      return items.length ? [base(entry, { items: items, last: true, kind: entry.source === 'core.continue' ? 'progress' : 'titles' })] : [];
    });
  }
  if (entry.source === 'core.library') {
    return libraryItems(entry, section, ctx).then(function (items) {
      return items.length ? [base(entry, { items: items.slice(0, 100), last: true, kind: 'library' })] : [];
    });
  }
  return Promise.resolve([base(entry)]);
}

function stripInternal(row) {
  var out = Object.assign({}, row);
  delete out.entry;
  delete out.offer;
  return out;
}

/** A profile's section, resolved */
function resolve(section, ctx) {
  if (rows.SECTIONS.indexOf(section) === -1) {
    return Promise.reject(failure('INVALID', 'section must be one of ' + rows.SECTIONS.join(', ')));
  }
  return entriesOf(section, ctx).then(function (r) {
    return Promise.all(r.entries.filter(function (entry) { return !entry.hidden; }).map(function (entry) {
      return expand(entry, section, r.entries, r.offers, ctx).catch(function (err) {
        log.warn('row ' + entry.id + ' (' + entry.source + ') left out: ' + err.message);
        return [];
      });
    })).then(function (lists) {
      var out = [];
      lists.forEach(function (l) { out = out.concat(l); });
      return watchedSet(ctx).then(function (watched) {
        return {
          section: section,
          own: !!r.layout.own,
          rows: out.map(function (row) {
            var entry = r.entries.filter(function (e) { return e.id === row.entry; })[0];
            return row.items ? Object.assign({}, row, { items: filtered(row, entry, watched, ctx) }) : row;
          }).filter(function (row) { return !row.items || row.items.length; }).map(stripInternal)
        };
      });
    });
  });
}

/** A row's items without what the profile watched (when its entry says so) and, for kids, catalog titles for them */
function filtered(row, entry, watched, ctx) {
  var offer = null;
  if (row.plugin && row.offer) {
    var p = plugins.get(row.plugin);
    offer = p && offersOf(p).filter(function (o) { return o.key === row.offer; })[0];
  }
  var hide = rows.hidesWatched(entry, offer && offer.personal);
  return (row.items || []).filter(function (item) {
    if (!hide) {
      return true;
    }
    var k = row.kind === 'cards' ? cardTitle(item) : titleKey(item.mediaType, item.tmdbId);
    return !k || !watched.has(k);
  });
}

// ── one row's page ──────────────────────────────────────────────────────────

function discoverQuery(params, page) {
  var q = { page: page };
  ['sort', 'genres', 'withoutGenres', 'language', 'from', 'to'].forEach(function (k) {
    if (params[k] !== undefined) {
      q[k] = String(params[k]);
    }
  });
  ['minVotes', 'minRating'].forEach(function (k) {
    if (params[k] !== undefined) {
      q[k] = String(params[k]);
    }
  });
  if (params.recentYears) {
    q.from = new Date(Date.now() - params.recentYears * 365 * DAY_MS).toISOString().slice(0, 10);
  }
  return q;
}

function catalogPage(entry, section, page, ctx) {
  var mediaType = mediaTypeOf(entry, section),
    work = entry.source === 'core.list' ? catalog.list(mediaType, entry.params.list, { page: page }) :
      catalog.discover(mediaType, discoverQuery(entry.params, page));
  return Promise.resolve(work).then(function (r) {
    return { kind: 'titles', items: r.results.filter(kidsKeep(ctx)), last: r.page >= r.totalPages };
  });
}

function offerPage(plugin, offer, values, page, ctx) {
  var args = Object.assign({}, offer.args, { key: offer.key, values: values || {}, page: page });
  return callData(plugin, offer.data, args, ctx, offer.personal).then(function (fill) {
    var out = { kind: 'cards', plugin: plugin.id, items: (fill && fill.items) || [], last: !fill || fill.last !== false };
    if (fill && fill.title) {
      out.title = fill.title;
    }
    return out;
  });
}

function legacyPage(plugin, section, part, page, ctx) {
  return legacyRows(plugin, section, ctx).then(function (list) {
    var row = list.filter(function (r) { return 's' + hash(r.key, 8) === part; })[0];
    if (!row) {
      throw failure('NOT_FOUND', 'no such row');
    }
    if (row.items) {
      return { kind: 'cards', plugin: plugin.id, items: page === 1 ? row.items : [], last: true };
    }
    return callData(plugin, row.page.data, Object.assign({}, row.page.args, { page: page }), ctx, true).then(function (p) {
      return { kind: 'cards', plugin: plugin.id, items: (p && p.items) || [], last: !p || p.last !== false };
    });
  });
}

function entryPage(entry, part, section, entries, offers, page, ctx) {
  var source = rows.source(entry.source) || {};
  if (source.personal && !ctx.profile) {
    return Promise.resolve({ kind: 'titles', items: [], last: true });
  }
  if (entry.source === 'core.list' || entry.source === 'core.discover') {
    return catalogPage(entry, section, page, ctx);
  }
  if (entry.source === 'plugin' || entry.source === 'plugin.all') {
    var plugin = pluginOf(entry.params.plugin, ctx);
    if (!plugin) {
      return Promise.reject(failure('NOT_FOUND', 'no such row'));
    }
    if (entry.source === 'plugin.all' && legacySlot(plugin, section)) {
      return legacyPage(plugin, section, part, page, ctx);
    }
    var key = entry.source === 'plugin' ? entry.params.row : part,
      offer = offersOf(plugin).filter(function (o) { return o.key === key; })[0];
    if (!offer || offer.sections.indexOf(section) === -1 ||
        (entry.source === 'plugin.all' && !groupOffers(plugin, section, entries, offers).some(function (o) { return o.key === key; }))) {
      return Promise.reject(failure('NOT_FOUND', 'no such row'));
    }
    return offerPage(plugin, offer, entry.source === 'plugin' ? entry.params.values : null, page, ctx);
  }
  // the rest come whole on page 1
  var whole;
  if (entry.source === 'core.because') {
    whole = becauseRows(entry, section, ctx).then(function (list) {
      var found = list.filter(function (b) { return seedPart(b.seed) === part; })[0];
      return { kind: 'titles', items: found ? found.items : [] };
    });
  } else if (entry.source === 'core.library') {
    whole = libraryItems(entry, section, ctx).then(function (items) { return { kind: 'library', items: items.slice(0, 100) }; });
  } else {
    whole = personalItems(entry, section, ctx).then(function (items) {
      return { kind: entry.source === 'core.continue' ? 'progress' : 'titles', items: items };
    });
  }
  return whole.then(function (r) {
    return { kind: r.kind, items: page === 1 ? r.items : [], last: true };
  });
}

/** One row's page: { id, kind, items, last, title?, plugin? } */
function items(section, rowId, page, ctx) {
  if (rows.SECTIONS.indexOf(section) === -1) {
    return Promise.reject(failure('INVALID', 'section must be one of ' + rows.SECTIONS.join(', ')));
  }
  if (typeof rowId !== 'string' || !/^r_[a-z0-9]{6,16}(~[A-Za-z0-9._-]{1,40})?$/.test(rowId)) {
    return Promise.reject(failure('INVALID', 'not a row id'));
  }
  page = page === undefined ? 1 : Number(page);
  if (!(page >= 1 && page <= 500 && Math.floor(page) === page)) {
    return Promise.reject(failure('INVALID', 'page must be a whole number from 1 to 500'));
  }
  var parts = rowId.split('~'), entryId = parts[0], part = parts[1] || null;
  return entriesOf(section, ctx).then(function (r) {
    var entry = r.entries.filter(function (e) { return e.id === entryId; })[0];
    if (!entry || (!!part !== !!(rows.source(entry.source) || {}).expands)) {
      throw failure('NOT_FOUND', 'no row ' + rowId + ' in ' + section);
    }
    var work = entryPage(entry, part, section, r.entries, r.offers, page, ctx).catch(function (err) {
      if (err.status) {
        throw err;
      }
      if (err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN') {
        throw failure('NOT_FOUND', 'no row ' + rowId + ' in ' + section);
      }
      var e = failure('PLUGIN_FAILED', err.message);
      throw e;
    });
    return Promise.all([work, watchedSet(ctx)]).then(function (x) {
      var out = Object.assign({ id: rowId }, x[0]);
      var offer = null;
      if (out.plugin) {
        var p = plugins.get(out.plugin);
        offer = p && offersOf(p).filter(function (o) { return o.key === (entry.source === 'plugin' ? entry.params.row : part); })[0];
      }
      out.items = filtered({ kind: out.kind, items: out.items, plugin: out.plugin, offer: offer && offer.key }, entry, x[1], ctx);
      return out;
    });
  });
}

// ── what can be added ───────────────────────────────────────────────────────

function paramView(def) {
  var out = { type: def.type };
  ['enum', 'min', 'max', 'required'].forEach(function (k) {
    if (def[k] !== undefined) {
      out[k] = def[k];
    }
  });
  if (def.pattern) {
    out.pattern = def.pattern.source;
  }
  return out;
}

/**
 * A layout to edit: its entries with the plugins joining it (new: true), and
 * `known` with them, so saving it back keeps a plugin taken out from joining again
 */
function editable(section, ctx) {
  if (rows.SECTIONS.indexOf(section) === -1) {
    return Promise.reject(failure('INVALID', 'section must be one of ' + rows.SECTIONS.join(', ')));
  }
  return entriesOf(section, ctx).then(function (r) {
    var known = r.layout.known.slice();
    r.entries.forEach(function (e) {
      if (e.new && known.indexOf(e.params.plugin) === -1) {
        known.push(e.params.plugin);
      }
    });
    return {
      section: section,
      own: !!r.layout.own,
      custom: !!r.layout.custom,
      updatedAt: r.layout.updatedAt,
      rows: r.entries.map(function (e) { return Object.assign({}, e, { label: labelOf(e, r.offers, ctx) }); }),
      known: known
    };
  });
}

/** What an editor calls an entry: its own title, else the offer's or the plugin's name, else the source's default */
function labelOf(entry, offers, ctx) {
  if (entry.title) {
    return entry.title;
  }
  if (!rows.isPlugin(entry.source)) {
    return rows.defaultTitle(entry);
  }
  var p = plugins.get(entry.params.plugin),
    name = p ? plugins.localize(p, p.manifest.name, ctx.locale || 'en') : entry.params.plugin;
  if (entry.source === 'plugin.all') {
    return name;
  }
  var offer = (offers[entry.params.plugin] || []).filter(function (o) { return o.key === entry.params.row; })[0];
  return offer ? offer.title : name + ' · ' + entry.params.row;
}

/** The core's sources and every visible plugin's offers */
function sources(ctx) {
  return offersNow(ctx).then(function (offers) { return sourcesWith(offers, ctx); });
}

function sourcesWith(offers, ctx) {
  var core = Object.keys(rows.SOURCES).filter(function (k) { return !rows.isPlugin(k); }).map(function (k) {
    var s = rows.SOURCES[k];
    return {
      source: k,
      label: s.label,
      personal: !!s.personal,
      expands: !!s.expands,
      params: Object.keys(s.params).reduce(function (all, p) { all[p] = paramView(s.params[p]); return all; }, {})
    };
  });
  var offered = visible(ctx).map(function (p) {
    var legacy = Object.keys(LEGACY_SLOTS).filter(function (section) { return legacySlot(p, section); });
    return {
      plugin: p.id,
      name: plugins.localize(p, p.manifest.name, ctx.locale || 'en'),
      rows: (offers[p.id] || []).map(function (o) {
        var out = { key: o.key, title: o.title, sections: o.sections, joins: o.joins, personal: !!o.personal, candidates: !!o.candidates };
        if (o.params.length) {
          out.params = o.params.map(function (x) {
            return { key: x.key, label: plugins.localize(p, x.label, ctx.locale || 'en'), options: x.options, required: !!x.required };
          });
        }
        if (o.variant) {
          out.variant = o.variant;
        }
        return out;
      }),
      // a plugin of before layouts: its rows only as a whole, where its slots put them
      slots: legacy
    };
  }).filter(function (p) { return p.rows.length || p.slots.length; });
  return { sections: rows.SECTIONS, lists: rows.LISTS, variants: rows.VARIANTS, core: core, plugins: offered };
}

module.exports = {
  resolve: resolve,
  items: items,
  sources: sources,
  editable: editable,
  joinId: joinId,
  KID_GENRES: KID_GENRES,
  // tests
  clearCache: function () { cache.clear(); }
};
