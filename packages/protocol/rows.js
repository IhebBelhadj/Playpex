'use strict';

// Rows and layouts (docs/rows-plan.md §3–§4), shared by the server (validates
// every layout it stores) and clients (the row editors: sources, params,
// default titles).
//
//   a section    home | movies | shows: an ordered list of row entries (a layout)
//   an entry     { id, source, params, title?, variant?, hideWatched?, candidates?, hidden? }
//                (hidden: kept in the layout, not shown: an editor's "Hide", undone by "Show")
//   a source     what fills a row: the core's (core.*) or a plugin's (plugin, plugin.all);
//                `expands` sources become several rows when a layout is resolved
//
// checkLayout(section, rows) → [problem…] (empty: valid). Plugin entries are
// checked for their shape only: whether the plugin offers that row is the
// server's business when it resolves the layout (a row whose plugin is gone stays
// in the layout and drops out of the answer).
// CommonJS with no dependencies, like settings.js.

var SECTIONS = ['home', 'movies', 'shows'];

var MEDIA_TYPES = ['movie', 'tv'];

// The section a media type belongs to (home takes both)
var SECTION_MEDIA = { home: MEDIA_TYPES, movies: ['movie'], shows: ['tv'] };

var LISTS = {
  movie: ['popular', 'top_rated', 'trending', 'now_playing', 'upcoming'],
  tv: ['popular', 'top_rated', 'trending', 'airing_today', 'on_the_air']
};

var LIST_TITLES = {
  popular: 'Popular', top_rated: 'Top rated', trending: 'Trending', now_playing: 'Now playing',
  upcoming: 'Coming soon', airing_today: 'Airing today', on_the_air: 'On the air'
};

var VARIANTS = ['poster', 'landscape', 'top10'];

var LIMITS = {
  rows: 60,          // entries in one layout
  title: 60,         // a row's own title
  expanded: 30,      // rows an expanding entry becomes (plugin.all)
  becauseMax: 3      // core.because rows
};

var ROW_ID = /^r_[a-z0-9]{6,16}$/,
  PLUGIN_ID = /^[a-z][a-z0-9-]{1,31}$/,
  OFFER_KEY = /^[a-z0-9][a-z0-9._-]{0,39}$/,
  VALUE_KEY = /^[a-z][A-Za-z0-9]{0,39}$/,
  GENRES = /^\d+([,|]\d+)*$/,
  DAY = /^\d{4}-\d{2}-\d{2}$/;

// A param: { type, enum?, pattern?, min?, max?, required?, mediaTypes? }
var MEDIA = { type: 'string', enum: MEDIA_TYPES };

// What fills a row. `personal`: depends on the profile (empty → left out of the
// answer); `hidesWatched`: hideWatched's default; `expands`: several rows when
// resolved; `media`: which param says the row's media type (checked against the section)
var SOURCES = {
  'core.list': {
    label: 'A TMDB list',
    params: { mediaType: Object.assign({ required: true }, MEDIA), list: { type: 'string', required: true } },
    media: 'mediaType'
  },
  'core.discover': {
    label: 'Titles by filters',
    params: {
      mediaType: Object.assign({ required: true }, MEDIA),
      sort: { type: 'string', enum: ['popularity', 'rating', 'newest'] },
      genres: { type: 'string', pattern: GENRES },
      withoutGenres: { type: 'string', pattern: GENRES },
      language: { type: 'string', pattern: /^[a-z]{2}$/ },
      minVotes: { type: 'integer', min: 0, max: 100000 },
      minRating: { type: 'number', min: 0, max: 10 },
      from: { type: 'string', pattern: DAY },
      to: { type: 'string', pattern: DAY },
      // released in the last n years (moves with the calendar, unlike from)
      recentYears: { type: 'integer', min: 1, max: 20 }
    },
    media: 'mediaType'
  },
  'core.continue': { label: 'Continue watching', params: { mediaType: MEDIA }, media: 'mediaType', personal: true },
  'core.watchlist': { label: 'My list', params: { mediaType: MEDIA }, media: 'mediaType', personal: true },
  'core.forYou': { label: 'For you', params: { mediaType: MEDIA }, media: 'mediaType', personal: true, hidesWatched: true },
  'core.because': {
    label: 'Because you watched…',
    params: { mediaType: MEDIA, count: { type: 'integer', min: 1, max: LIMITS.becauseMax } },
    media: 'mediaType', personal: true, hidesWatched: true, expands: true
  },
  'core.library': {
    label: 'On this server',
    params: { mediaType: MEDIA, order: { type: 'string', enum: ['added', 'title'] } },
    media: 'mediaType'
  },
  plugin: {
    label: 'A plugin\'s row',
    params: {
      plugin: { type: 'string', pattern: PLUGIN_ID, required: true },
      row: { type: 'string', pattern: OFFER_KEY, required: true },
      values: { type: 'object' }
    }
  },
  'plugin.all': {
    label: 'A plugin\'s rows',
    params: { plugin: { type: 'string', pattern: PLUGIN_ID, required: true } },
    expands: true
  }
};

function has(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function source(name) {
  return typeof name === 'string' && has(SOURCES, name) ? SOURCES[name] : null;
}

function isPlugin(name) {
  return name === 'plugin' || name === 'plugin.all';
}

function paramProblem(name, def, value) {
  if (def.type === 'string') {
    if (typeof value !== 'string' || !value.length || value.length > 200) {
      return name + ' must be a text';
    }
    if (def.enum && def.enum.indexOf(value) === -1) {
      return name + ' must be one of ' + def.enum.join(', ');
    }
    if (def.pattern && !def.pattern.test(value)) {
      return name + ' is not valid';
    }
    return null;
  }
  if (def.type === 'integer' || def.type === 'number') {
    if (typeof value !== 'number' || !isFinite(value) || (def.type === 'integer' && Math.floor(value) !== value)) {
      return name + ' must be a' + (def.type === 'integer' ? ' whole' : '') + ' number';
    }
    if ((def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max)) {
      return name + ' must be between ' + def.min + ' and ' + def.max;
    }
    return null;
  }
  if (def.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return name + ' must be an object';
    }
    var keys = Object.keys(value);
    if (keys.length > 8) {
      return name + ': at most 8 values';
    }
    for (var i = 0; i < keys.length; i++) {
      var v = value[keys[i]];
      if (!VALUE_KEY.test(keys[i]) || typeof v !== 'string' || v.length > 200) {
        return name + '.' + keys[i] + ' must be a text';
      }
    }
    return null;
  }
  return name + ': unknown type';
}

/** The media types an entry shows (null: any), from its source's media param */
function mediaOf(entry) {
  var s = source(entry && entry.source);
  if (!s || !s.media) {
    return null;
  }
  var m = entry.params && entry.params[s.media];
  return m ? [m] : null;
}

/** Problems of one entry, prefixed with its place */
function entryProblems(section, entry, at) {
  var out = [];
  function problem(text) {
    out.push(at + ': ' + text);
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    problem('must be an object');
    return out;
  }
  var allowed = ['id', 'source', 'params', 'title', 'variant', 'hideWatched', 'candidates', 'hidden'];
  Object.keys(entry).forEach(function (k) {
    if (allowed.indexOf(k) === -1) {
      problem('unknown field ' + k);
    }
  });
  if (typeof entry.id !== 'string' || !ROW_ID.test(entry.id)) {
    problem('id must be r_ and 6 to 16 lowercase letters or digits');
  }
  var s = source(entry.source);
  if (!s) {
    problem('source must be one of ' + Object.keys(SOURCES).join(', '));
    return out;
  }
  var params = entry.params === undefined ? {} : entry.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    problem('params must be an object');
    return out;
  }
  Object.keys(params).forEach(function (k) {
    if (!has(s.params, k)) {
      problem('params.' + k + ' is not a param of ' + entry.source);
    }
  });
  Object.keys(s.params).forEach(function (k) {
    var def = s.params[k];
    if (params[k] === undefined || params[k] === null) {
      if (def.required) {
        problem('params.' + k + ' is required');
      }
      return;
    }
    var p = paramProblem('params.' + k, def, params[k]);
    if (p) {
      problem(p);
    }
  });
  if (entry.source === 'core.list' && params.mediaType && LISTS[params.mediaType] && LISTS[params.mediaType].indexOf(params.list) === -1) {
    problem('params.list must be one of ' + LISTS[params.mediaType].join(', '));
  }
  if (entry.source === 'core.discover' && params.from && params.recentYears) {
    problem('params: from or recentYears, not both');
  }
  var media = mediaOf(entry);
  if (media && media.some(function (m) { return SECTION_MEDIA[section].indexOf(m) === -1; })) {
    problem(media[0] + ' rows don\'t go in ' + section);
  }
  if (entry.title !== undefined && (typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > LIMITS.title)) {
    problem('title must be a text of at most ' + LIMITS.title + ' characters');
  }
  if (entry.variant !== undefined && VARIANTS.indexOf(entry.variant) === -1) {
    problem('variant must be one of ' + VARIANTS.join(', '));
  }
  ['hideWatched', 'candidates', 'hidden'].forEach(function (k) {
    if (entry[k] !== undefined && typeof entry[k] !== 'boolean') {
      problem(k + ' must be true or false');
    }
  });
  if (entry.candidates !== undefined && !isPlugin(entry.source)) {
    problem('candidates is for plugin rows');
  }
  return out;
}

/** Problems of a whole layout (empty: valid) */
function checkLayout(section, rows) {
  if (SECTIONS.indexOf(section) === -1) {
    return ['section must be one of ' + SECTIONS.join(', ')];
  }
  if (!Array.isArray(rows)) {
    return ['rows must be a list'];
  }
  if (rows.length > LIMITS.rows) {
    return ['at most ' + LIMITS.rows + ' rows'];
  }
  var out = [], ids = {}, alls = {};
  rows.forEach(function (entry, i) {
    out = out.concat(entryProblems(section, entry, 'rows[' + i + ']'));
    if (entry && typeof entry.id === 'string') {
      if (ids[entry.id]) {
        out.push('rows[' + i + ']: id ' + entry.id + ' twice');
      }
      ids[entry.id] = true;
    }
    if (entry && entry.source === 'plugin.all' && entry.params && entry.params.plugin) {
      if (alls[entry.params.plugin]) {
        out.push('rows[' + i + ']: ' + entry.params.plugin + '\'s rows twice');
      }
      alls[entry.params.plugin] = true;
    }
  });
  return out;
}

var GENRE_NAMES = {
  movie: { 16: 'Animation', 35: 'Comedy', 27: 'Horror', 28: 'Action', 10751: 'Family', 37: 'Western', 18: 'Drama', 878: 'Science fiction', 53: 'Thriller', 99: 'Documentary' },
  tv: { 18: 'Drama', 35: 'Comedy', 80: 'Crime', 10765: 'Sci-Fi & Fantasy', 16: 'Animation', 99: 'Documentaries', 10759: 'Action & Adventure' }
};

/** The title an entry shows without its own (an expanding source's rows name themselves) */
function defaultTitle(entry) {
  var p = (entry && entry.params) || {},
    kind = p.mediaType === 'movie' ? ' movies' : p.mediaType === 'tv' ? ' shows' : '';
  switch (entry && entry.source) {
    case 'core.list':
      return (LIST_TITLES[p.list] || 'Popular') + kind;
    case 'core.discover':
      var first = p.genres && GENRE_NAMES[p.mediaType] && GENRE_NAMES[p.mediaType][String(p.genres).split(/[,|]/)[0]];
      return first || (p.sort === 'rating' ? 'Top rated' : p.sort === 'newest' ? 'Newest' : 'Popular') + kind;
    case 'core.continue':
      return 'Continue watching';
    case 'core.watchlist':
      return 'My list';
    case 'core.forYou':
      return 'For you';
    case 'core.library':
      return 'On this server';
    default:
      return SOURCES[entry && entry.source] ? SOURCES[entry.source].label : '';
  }
}

/** Whether a row of this entry drops what the profile watched (personalOffer: a plugin offer's `personal`) */
function hidesWatched(entry, personalOffer) {
  if (entry && typeof entry.hideWatched === 'boolean') {
    return entry.hideWatched;
  }
  var s = source(entry && entry.source);
  return !!((s && s.hidesWatched) || (isPlugin(entry && entry.source) && personalOffer));
}

/** A new entry id (r_ + 10 base-36 characters) */
function newRowId(random) {
  var r = random || Math.random, out = 'r_';
  for (var i = 0; i < 10; i++) {
    out += Math.floor(r() * 36).toString(36);
  }
  return out;
}

module.exports = {
  SECTIONS: SECTIONS,
  SECTION_MEDIA: SECTION_MEDIA,
  MEDIA_TYPES: MEDIA_TYPES,
  LISTS: LISTS,
  VARIANTS: VARIANTS,
  LIMITS: LIMITS,
  SOURCES: SOURCES,
  ROW_ID: ROW_ID,
  OFFER_KEY: OFFER_KEY,
  source: source,
  isPlugin: isPlugin,
  mediaOf: mediaOf,
  checkLayout: checkLayout,
  defaultTitle: defaultTitle,
  hidesWatched: hidesWatched,
  newRowId: newRowId
};
