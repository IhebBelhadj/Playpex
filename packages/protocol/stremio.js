'use strict';

// Stremio's add-on protocol as the bridge accepts it (docs/stremio-bridge-plan.md
// §2, §9, the spike's §12.1). An add-on is data, never code: everything it
// answers is read through these cleaners, which keep only the fields Playpex
// uses, cap every string and list, and drop what is out of shape. Shared by
// the server (lib/plugins/stremio) and its tests; no I/O here.
//
//   addonUrl(text) → { manifest, base, host, configured } | throws INVALID
//   requestPath(resource, type, id, extra) → '/stream/movie/tt0111161.json'
//   cleanManifest(json) → { manifest, unused } | throws INVALID
//   clean(resource, json) → the answer kept ({ streams } | { metas } | { meta } | { subtitles }) + cache
//   seedersOf(text), sizeOf(text)   the conventions of torrent add-ons' free text (decision D)
//   language(code) → an ISO 639-1 code where one exists ('eng' → 'en', 'pob' → 'pt-BR'), else the code

var LIMITS = {
  manifestBytes: 256 * 1024,
  answerBytes: 2 * 1024 * 1024,
  streams: 500,
  metas: 200,
  videos: 5000,
  subtitles: 300,
  catalogs: 40,
  text: 300,          // a name, a label
  longText: 4000,     // a description
  id: 512,
  url: 2048,
  cacheMax: { stream: 6 * 3600, subtitles: 6 * 3600, catalog: 24 * 3600, meta: 24 * 3600, addon_catalog: 24 * 3600 },
  cacheDefault: { stream: 900, subtitles: 3600, catalog: 3 * 3600, meta: 6 * 3600, addon_catalog: 6 * 3600 },
  addons: 500,
  staleMax: 7 * 24 * 3600
};

var RESOURCES = ['catalog', 'meta', 'stream', 'subtitles', 'addon_catalog'],
  // the types Playpex has a place for; others ('music', 'Dice'…) are dropped
  TYPES = ['movie', 'series', 'anime', 'channel', 'tv', 'other'],
  POSTER_SHAPES = ['poster', 'landscape', 'square'];

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v, max) {
  if (typeof v === 'number' && isFinite(v)) {
    v = String(v);
  }
  if (typeof v !== 'string') {
    return null;
  }
  // control characters out (newlines kept: torrent add-ons' lines)
  v = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return v ? v.slice(0, max || LIMITS.text) : null;
}

function num(v, min, max) {
  var n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && isFinite(n) && n >= (min === undefined ? -Infinity : min) && n <= (max === undefined ? Infinity : max) ? n : null;
}

function int(v, min, max) {
  var n = num(v, min, max);
  return n === null ? null : Math.floor(n);
}

/** An http(s) URL, at most 2048 characters, without credentials; `httpsOnly`: https alone */
function webUrl(v, httpsOnly) {
  if (typeof v !== 'string' || v.length > LIMITS.url) {
    return null;
  }
  var u;
  try {
    u = new URL(v.trim());
  } catch (e) {
    return null;
  }
  if ((u.protocol !== 'https:' && (httpsOnly || u.protocol !== 'http:')) || u.username || u.password) {
    return null;
  }
  return u.href;
}

function strings(list, max, each) {
  return Array.isArray(list) ? list.map(function (x) { return str(x, each || 60); }).filter(Boolean).slice(0, max) : [];
}

function id(v) {
  var s = typeof v === 'number' ? String(v) : v;
  return typeof s === 'string' && s.length && s.length <= LIMITS.id && !/[\u0000-\u001f\u007f]/.test(s) ? s : null;
}

// ── the add-on's address ────────────────────────────────────────────────────

/**
 * The manifest URL the admin pastes (`https://host/[config/]manifest.json`,
 * `stremio://…` the same over https). `configured`: the path before
 * manifest.json looks like a configuration (where configurable add-ons keep
 * their settings and keys): a segment with `=`, `|`, `,`, `%`, `{`, or one
 * of 24+ characters (base64 / JSON); a plain path (`/publicdomainmovies/`)
 * is only where an add-on lives
 */
function addonUrl(text) {
  var raw = String(text || '').trim();
  if (/^stremio:\/\//i.test(raw)) {
    raw = 'https://' + raw.replace(/^stremio:\/\//i, '');
  }
  var u;
  try {
    u = new URL(raw);
  } catch (e) {
    throw failure('INVALID', 'not an address: paste the add-on\'s manifest URL (https://…/manifest.json)');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw failure('INVALID', 'an add-on address starts with https:// or stremio://');
  }
  if (u.username || u.password) {
    throw failure('INVALID', 'no user name or password in the address');
  }
  u.hash = '';
  u.search = '';
  if (!/\/manifest\.json$/.test(u.pathname)) {
    u.pathname = u.pathname.replace(/\/+$/, '') + '/manifest.json';
  }
  if (u.href.length > LIMITS.url) {
    throw failure('INVALID', 'that address is too long');
  }
  var base = u.href.replace(/\/manifest\.json$/, '');
  return {
    manifest: u.href,
    base: base,
    host: u.hostname.toLowerCase(),
    port: u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80,
    scheme: u.protocol.replace(':', ''),
    configured: u.pathname.replace(/\/manifest\.json$/, '').split('/').some(function (seg) {
      return /[=|,%{]/.test(seg) || seg.length >= 24;
    })
  };
}

/** extra: { search, genre, skip, videoHash, videoSize, filename } → 'genre=Action&skip=100' (Stremio's order kept) */
function extraOf(extra) {
  if (!isObject(extra)) {
    return '';
  }
  return Object.keys(extra).filter(function (k) {
    return /^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k) && extra[k] !== undefined && extra[k] !== null && extra[k] !== '';
  }).slice(0, 8).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(String(extra[k]).slice(0, 300));
  }).join('&');
}

function requestPath(resource, type, itemId, extra) {
  if (RESOURCES.indexOf(resource) === -1) {
    throw failure('INVALID', 'resource: one of ' + RESOURCES.join(', '));
  }
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(String(type || ''))) {
    throw failure('INVALID', 'type: a Stremio type');
  }
  if (!id(itemId)) {
    throw failure('INVALID', 'id: at most ' + LIMITS.id + ' characters');
  }
  var e = extraOf(extra);
  return '/' + resource + '/' + encodeURIComponent(type) + '/' + encodeURIComponent(itemId) + (e ? '/' + e : '') + '.json';
}

// ── the manifest ────────────────────────────────────────────────────────────

function resourceOf(r, m) {
  var name = typeof r === 'string' ? r : isObject(r) ? r.name : null;
  if (RESOURCES.indexOf(name) === -1) {
    return { unused: typeof name === 'string' ? name.slice(0, 40) : null };
  }
  var types = isObject(r) && Array.isArray(r.types) ? r.types : m.types,
    prefixes = isObject(r) && Array.isArray(r.idPrefixes) ? r.idPrefixes : m.idPrefixes;
  return {
    name: name,
    types: strings(types, 20, 40),
    idPrefixes: Array.isArray(prefixes) ? strings(prefixes, 40, 40) : null
  };
}

function catalogOf(c) {
  if (!isObject(c) || !str(c.type, 40) || !id(c.id)) {
    return null;
  }
  var extra = (Array.isArray(c.extra) ? c.extra : []).filter(isObject).slice(0, 10).map(function (e) {
    var name = str(e.name, 30);
    return name ? {
      name: name,
      isRequired: e.isRequired === true,
      options: strings(e.options, 100, 60),
      optionsLimit: int(e.optionsLimit, 1, 100)
    } : null;
  }).filter(Boolean);
  // the old way of saying it (extraSupported / extraRequired)
  strings(c.extraSupported, 10, 30).forEach(function (name) {
    if (!extra.some(function (e) { return e.name === name; })) {
      extra.push({ name: name, isRequired: strings(c.extraRequired, 10, 30).indexOf(name) !== -1, options: name === 'genre' ? strings(c.genres, 100, 60) : [], optionsLimit: null });
    }
  });
  return { type: str(c.type, 40), id: c.id.slice(0, 200), name: str(c.name, 80) || c.id.slice(0, 80), extra: extra };
}

/** The add-on's manifest, kept: throws INVALID when it can't be one */
function cleanManifest(json) {
  if (!isObject(json)) {
    throw failure('INVALID', 'that address doesn\'t answer an add-on manifest (JSON)');
  }
  var addonId = str(json.id, 200), name = str(json.name, 60);
  if (!addonId || !name) {
    throw failure('INVALID', 'not an add-on manifest: no id or name');
  }
  var unused = [];
  json.types = Array.isArray(json.types) ? json.types : [];
  var resources = (Array.isArray(json.resources) ? json.resources : []).slice(0, 20).map(function (r) {
    return resourceOf(r, json);
  }).filter(function (r) {
    if (!r.name) {
      if (r.unused) {
        unused.push(r.unused);
      }
      return false;
    }
    return true;
  });
  var catalogs = (Array.isArray(json.catalogs) ? json.catalogs : []).slice(0, LIMITS.catalogs).map(catalogOf).filter(Boolean),
    // the add-ons it lists (addon_catalog): offered on its dashboard page
    addonCatalogs = (Array.isArray(json.addonCatalogs) ? json.addonCatalogs : []).slice(0, 20).filter(function (c) {
      return isObject(c) && str(c.type, 40) && id(c.id);
    }).map(function (c) { return { type: str(c.type, 40), id: c.id.slice(0, 200), name: str(c.name, 80) || c.id.slice(0, 80) }; }),
    hints = isObject(json.behaviorHints) ? json.behaviorHints : {};
  return {
    manifest: {
      id: addonId,
      name: name,
      version: str(json.version, 40) || '0.0.0',
      description: str(json.description, LIMITS.longText),
      logo: webUrl(json.logo, true),
      background: webUrl(json.background, true),
      types: strings(json.types, 20, 40),
      idPrefixes: Array.isArray(json.idPrefixes) ? strings(json.idPrefixes, 40, 40) : null,
      resources: resources,
      catalogs: catalogs,
      addonCatalogs: resources.some(function (r) { return r.name === 'addon_catalog'; }) ? addonCatalogs : [],
      behaviorHints: {
        adults: hints.adult === true,   // plugins-check: allow (Stremio's own field name: such an add-on becomes audience adults)
        p2p: hints.p2p === true,
        configurable: hints.configurable === true,
        configurationRequired: hints.configurationRequired === true
      }
    },
    unused: unused
  };
}

/** Whether the add-on answers `resource` for this type and id */
function offers(manifest, resource, type, itemId) {
  return manifest.resources.some(function (r) {
    if (r.name !== resource) {
      return false;
    }
    if (type && r.types.length && r.types.indexOf(type) === -1) {
      return false;
    }
    // id prefixes name items, not catalogs
    return resource === 'catalog' || !itemId || !r.idPrefixes || !r.idPrefixes.length || r.idPrefixes.some(function (p) { return itemId.indexOf(p) === 0; });
  });
}

// ── answers ─────────────────────────────────────────────────────────────────

function cacheOf(json, resource) {
  var max = LIMITS.cacheMax[resource] || 3600;
  return {
    maxAge: int(json.cacheMaxAge, 0, max),
    staleRevalidate: int(json.staleRevalidate, 0, LIMITS.staleMax),
    staleError: int(json.staleError, 0, LIMITS.staleMax)
  };
}

function headersOf(h) {
  if (!isObject(h)) {
    return null;
  }
  var out = {}, n = 0;
  Object.keys(h).forEach(function (k) {
    var v = str(h[k], 2048);
    if (n < 8 && /^[A-Za-z0-9-]{1,64}$/.test(k) && v && !/[\r\n]/.test(v)) {
      out[k] = v;
      n++;
    }
  });
  return n ? out : null;
}

/**
 * A Stream kept: { kind: torrent|url|youtube|external|other, … } with its
 * texts; `kind` other = one Playpex can't play (counted, dropped by the adapter)
 */
function streamOf(s) {
  if (!isObject(s)) {
    return null;
  }
  var hints = isObject(s.behaviorHints) ? s.behaviorHints : {},
    out = {
      name: str(s.name, LIMITS.text),
      title: str(s.title || s.description, 1000),
      bingeGroup: str(hints.bingeGroup, 200),
      filename: str(hints.filename, 500),
      videoSize: int(hints.videoSize, 0),
      countryWhitelist: strings(hints.countryWhitelist, 50, 3).map(function (c) { return c.toLowerCase(); })
    };
  if (typeof s.infoHash === 'string' && /^[0-9a-fA-F]{40}$/.test(s.infoHash)) {
    out.kind = 'torrent';
    out.infoHash = s.infoHash.toLowerCase();
    out.fileIdx = int(s.fileIdx, 0, 100000);
    out.trackers = strings(s.sources, 30, 300).filter(function (t) { return /^tracker:(udp|https?|wss?):\/\//i.test(t); }).map(function (t) { return t.slice(8); });
  } else if (typeof s.url === 'string' && webUrl(s.url)) {
    out.kind = 'url';
    out.url = webUrl(s.url);
    var proxy = isObject(hints.proxyHeaders) ? hints.proxyHeaders : {};
    out.headers = headersOf(proxy.request);
  } else if (typeof s.ytId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(s.ytId)) {
    out.kind = 'youtube';
    out.ytId = s.ytId;
  } else if (typeof s.externalUrl === 'string') {
    out.kind = 'external';
  } else {
    out.kind = 'other';
  }
  return out;
}

function metaOf(m, full) {
  if (!isObject(m) || !id(m.id)) {
    return null;
  }
  var links = Array.isArray(m.links) ? m.links : [];
  function people(field, category) {
    var list = strings(m[field], 20, 80);
    links.forEach(function (l) {
      if (isObject(l) && l.category === category && str(l.name, 80) && list.indexOf(str(l.name, 80)) === -1 && list.length < 20) {
        list.push(str(l.name, 80));
      }
    });
    return list;
  }
  var genres = strings(m.genres || m.genre, 8, 40);
  links.forEach(function (l) {
    if (isObject(l) && l.category === 'Genres' && genres.length < 8 && str(l.name, 40) && genres.indexOf(str(l.name, 40)) === -1) {
      genres.push(str(l.name, 40));
    }
  });
  var imdb = typeof m.imdb_id === 'string' && /^tt\d{5,10}$/.test(m.imdb_id) ? m.imdb_id : /^tt\d{5,10}$/.test(m.id) ? m.id : null,
    out = {
      id: m.id,
      type: str(m.type, 40),
      name: str(m.name, LIMITS.text) || m.id.slice(0, 80),
      poster: webUrl(m.poster, true),
      posterShape: POSTER_SHAPES.indexOf(m.posterShape) !== -1 ? m.posterShape : 'poster',
      background: webUrl(m.background, true),
      logo: webUrl(m.logo, true),
      description: str(m.description, LIMITS.longText),
      releaseInfo: str(m.releaseInfo !== undefined ? m.releaseInfo : m.year, 40),
      imdbRating: num(m.imdbRating, 0, 10),
      genres: genres,
      imdbId: imdb,
      tmdbId: int(m.moviedb_id, 1) || null,
      animeType: str(m.animeType, 20)
    };
  if (full) {
    out.cast = people('cast', 'Cast');
    out.director = people('director', 'Directors');
    out.runtime = str(m.runtime, 40);
    out.videos = (Array.isArray(m.videos) ? m.videos : []).slice(0, LIMITS.videos).map(function (v) {
      if (!isObject(v) || !id(v.id)) {
        return null;
      }
      return {
        id: v.id,
        title: str(v.title || v.name, LIMITS.text),
        season: int(v.season, 0, 10000),
        episode: int(v.episode !== undefined ? v.episode : v.number, 0, 100000),
        released: str(v.released || v.firstAired, 40),
        thumbnail: webUrl(v.thumbnail, true),
        overview: str(v.overview || v.description, 1000),
        imdbId: typeof v.imdb_id === 'string' && /^tt\d{5,10}$/.test(v.imdb_id) ? v.imdb_id : null,
        imdbSeason: int(v.imdbSeason, 0, 10000),
        imdbEpisode: int(v.imdbEpisode, 0, 100000)
      };
    }).filter(Boolean);
  }
  return out;
}

function subtitleOf(s) {
  if (!isObject(s) || !webUrl(s.url, true)) {
    return null;
  }
  var lang = str(s.lang, 20);
  return lang ? { id: str(s.id, 100) || webUrl(s.url, true).slice(-60), url: webUrl(s.url, true), lang: lang, fileName: str(s.subtitleFileName, 200) } : null;
}

/** An answer of `resource`, kept: throws INVALID when it isn't one */
function clean(resource, json) {
  if (!isObject(json)) {
    throw failure('INVALID', 'the add-on\'s ' + resource + ' answer isn\'t a JSON object');
  }
  var out = { cache: cacheOf(json, resource) };
  if (resource === 'stream') {
    if (json.streams !== undefined && !Array.isArray(json.streams)) {
      throw failure('INVALID', 'streams isn\'t a list');
    }
    out.streams = (json.streams || []).slice(0, LIMITS.streams).map(streamOf).filter(Boolean);
  } else if (resource === 'catalog') {
    if (json.metas !== undefined && !Array.isArray(json.metas)) {
      throw failure('INVALID', 'metas isn\'t a list');
    }
    out.metas = (json.metas || []).slice(0, LIMITS.metas).map(function (m) { return metaOf(m, false); }).filter(Boolean);
  } else if (resource === 'meta') {
    out.meta = json.meta === null || json.meta === undefined ? null : metaOf(json.meta, true);
    if (json.meta && !out.meta) {
      throw failure('INVALID', 'meta isn\'t one');
    }
  } else if (resource === 'subtitles') {
    if (json.subtitles !== undefined && !Array.isArray(json.subtitles)) {
      throw failure('INVALID', 'subtitles isn\'t a list');
    }
    out.subtitles = (json.subtitles || []).slice(0, LIMITS.subtitles).map(subtitleOf).filter(Boolean);
  } else if (resource === 'addon_catalog') {
    if (json.addons !== undefined && !Array.isArray(json.addons)) {
      throw failure('INVALID', 'addons isn\'t a list');
    }
    // each listed add-on as Stremio's collection holds it: read with cleanManifest when it's offered
    out.addons = (json.addons || []).slice(0, LIMITS.addons).filter(function (a) {
      return isObject(a) && typeof a.transportUrl === 'string' && a.transportUrl.length <= LIMITS.url && isObject(a.manifest);
    }).map(function (a) { return { transportUrl: a.transportUrl, manifest: a.manifest, flags: isObject(a.flags) ? { official: a.flags.official === true } : {} }; });
  } else {
    throw failure('INVALID', 'resource: one of ' + RESOURCES.join(', '));
  }
  return out;
}

/** The empty answer of a resource (an add-on's 404) */
function empty(resource) {
  var out = { cache: { maxAge: null, staleRevalidate: null, staleError: null } };
  out[{ stream: 'streams', catalog: 'metas', meta: 'meta', subtitles: 'subtitles', addon_catalog: 'addons' }[resource]] = resource === 'meta' ? null : [];
  return out;
}

// ── free-text conventions (decision D) ──────────────────────────────────────

/** 👤 123 (Torrentio and its copies), "Seeders: 123", "S: 123", "⬆️ 123" */
function seedersOf(text) {
  var m = /👤\s*(\d{1,7})/.exec(text || '') || /(?:seed(?:er)?s?|⬆️|🌱)\s*[:=]?\s*(\d{1,7})/i.exec(text || '');
  return m ? parseInt(m[1], 10) : null;
}

/** 💾 1.44 GB, "Size: 700 MB" → bytes */
function sizeOf(text) {
  var m = /(?:💾|size\s*[:=]?)\s*([\d.,]+)\s*(TB|GB|MB|KB|GiB|MiB|TiB|KiB)\b/i.exec(text || '');
  if (!m) {
    return null;
  }
  var n = parseFloat(m[1].replace(',', '.')), unit = m[2].toUpperCase().replace('I', '');
  return isFinite(n) ? Math.round(n * { KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 }[unit]) : null;
}

// ISO 639-2 (B and T) → 639-1; Stremio's subtitle add-ons answer the former
var LANGUAGES = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', pob: 'pt-BR', rus: 'ru', jpn: 'ja',
  kor: 'ko', chi: 'zh', zho: 'zh', ara: 'ar', heb: 'he', tur: 'tr', pol: 'pl', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no',
  nob: 'nb', dan: 'da', fin: 'fi', cze: 'cs', ces: 'cs', slo: 'sk', slk: 'sk', slv: 'sl', hun: 'hu', rum: 'ro', ron: 'ro',
  bul: 'bg', gre: 'el', ell: 'el', srp: 'sr', scc: 'sr', hrv: 'hr', scr: 'hr', bos: 'bs', mac: 'mk', mkd: 'mk', alb: 'sq',
  sqi: 'sq', ukr: 'uk', bel: 'be', est: 'et', lav: 'lv', lit: 'lt', ice: 'is', isl: 'is', per: 'fa', fas: 'fa', hin: 'hi',
  ben: 'bn', tam: 'ta', tel: 'te', mal: 'ml', urd: 'ur', tha: 'th', vie: 'vi', ind: 'id', may: 'ms', msa: 'ms', fil: 'tl',
  tgl: 'tl', cat: 'ca', baq: 'eu', eus: 'eu', glg: 'gl', geo: 'ka', kat: 'ka', arm: 'hy', hye: 'hy', aze: 'az', kaz: 'kk',
  mon: 'mn', khm: 'km', lao: 'lo', bur: 'my', mya: 'my', nep: 'ne', sin: 'si', afr: 'af', swa: 'sw', amh: 'am', wel: 'cy',
  cym: 'cy', gle: 'ga', epo: 'eo', lat: 'la', ze: 'zh', zht: 'zh-TW', zhe: 'zh', spn: 'es', 'pt-br': 'pt-BR'
};

function language(code) {
  var c = String(code || '').trim();
  var k = c.toLowerCase();
  if (LANGUAGES[k]) {
    return LANGUAGES[k];
  }
  var m = /^([a-z]{2,3})(?:[-_]([A-Za-z]{2,4}))?$/.exec(c);
  return m ? m[1].toLowerCase() + (m[2] ? '-' + m[2].toUpperCase() : '') : null;
}

module.exports = {
  LIMITS: LIMITS,
  RESOURCES: RESOURCES,
  TYPES: TYPES,
  addonUrl: addonUrl,
  requestPath: requestPath,
  cleanManifest: cleanManifest,
  offers: offers,
  clean: clean,
  empty: empty,
  seedersOf: seedersOf,
  sizeOf: sizeOf,
  language: language,
  webUrl: webUrl
};
