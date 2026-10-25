'use strict';

// The catalog clients browse (docs/providers-plan.md §7.1, step 6): TMDB
// behind the server, answered in our own shapes (openapi.yaml `Catalog*`), so
// clients hold no key and the provider can change without changing them.
// Images stay TMDB paths (`imageBase` + a size + the path). Cached by
// lib/tmdb.js: details 6 h, lists / discover / search 1 h. Never adult titles
// (`include_adult` false: adults plugins have catalogs of their own).

var tmdb = require('./tmdb'),
  settings = require('./settings'),
  errors = require('./services/errors');

var LIST_TTL = 60 * 60 * 1000,
  MAX_PAGE = 500;            // TMDB serves no page past 500

var IMAGE_BASE = 'https://image.tmdb.org/t/p/';

// list id → TMDB path, per media type
var LISTS = {
  movie: {
    popular: '/movie/popular',
    top_rated: '/movie/top_rated',
    now_playing: '/movie/now_playing',
    upcoming: '/movie/upcoming',
    trending: '/trending/movie/week'
  },
  tv: {
    popular: '/tv/popular',
    top_rated: '/tv/top_rated',
    airing_today: '/tv/airing_today',
    on_the_air: '/tv/on_the_air',
    trending: '/trending/tv/week'
  }
};

var SEARCH_KINDS = ['multi', 'movie', 'tv', 'person'];

// ── our shapes ──────────────────────────────────────────────────────────────

function date(value) {
  return value || null;
}

/** A movie / show of a list (CatalogTitle) */
function title(mediaType, r) {
  var released = date(r.release_date || r.first_air_date);
  return {
    mediaType: mediaType,
    tmdbId: r.id,
    title: r.title || r.name || '',
    originalTitle: r.original_title || r.original_name || null,
    releaseDate: released,
    year: released ? released.slice(0, 4) : null,
    overview: r.overview || '',
    posterPath: r.poster_path || null,
    backdropPath: r.backdrop_path || null,
    genreIds: r.genre_ids || (r.genres || []).map(function (g) { return g.id; }),
    voteAverage: r.vote_average || 0,
    voteCount: r.vote_count || 0,
    originalLanguage: r.original_language || null
  };
}

/** A person of a search (CatalogPerson) */
function person(r) {
  return {
    mediaType: 'person',
    personId: r.id,
    name: r.name || '',
    profilePath: r.profile_path || null,
    knownForDepartment: r.known_for_department || null
  };
}

function cast(c) {
  return {
    personId: c.id,
    name: c.name || '',
    character: c.character || null,
    profilePath: c.profile_path || null,
    creditId: c.credit_id || String(c.id),
    order: typeof c.order === 'number' ? c.order : null
  };
}

function crew(c) {
  return {
    personId: c.id,
    name: c.name || '',
    job: c.job || null,
    department: c.department || null,
    profilePath: c.profile_path || null,
    creditId: c.credit_id || String(c.id)
  };
}

function page(data, item) {
  return {
    page: data.page || 1,
    totalPages: Math.min(MAX_PAGE, data.total_pages || 0),
    totalResults: data.total_results || 0,
    results: (data.results || []).map(item).filter(Boolean)
  };
}

/** A movie's / show's page (CatalogDetails) */
function details(mediaType, d) {
  var out = title(mediaType, d),
    ids = d.external_ids || {};
  out.imdbId = d.imdb_id || ids.imdb_id || null;
  out.genres = (d.genres || []).map(function (g) { return { id: g.id, name: g.name }; });
  out.runtime = (mediaType === 'movie' ? d.runtime : (d.episode_run_time || [])[0]) || null;
  out.tagline = d.tagline || null;
  out.status = d.status || null;
  out.videos = ((d.videos && d.videos.results) || []).map(function (v) {
    return { key: v.key, name: v.name || '', site: v.site || '', type: v.type || '', official: !!v.official };
  });
  if (mediaType === 'tv') {
    out.seasonCount = d.number_of_seasons || 0;
    out.episodeCount = d.number_of_episodes || 0;
    out.seasons = (d.seasons || []).map(function (s) {
      return {
        seasonNumber: s.season_number,
        name: s.name || '',
        overview: s.overview || '',
        airDate: date(s.air_date),
        episodeCount: s.episode_count || 0,
        posterPath: s.poster_path || null
      };
    });
  }
  return out;
}

function episode(e) {
  return {
    seasonNumber: e.season_number,
    episodeNumber: e.episode_number,
    name: e.name || '',
    overview: e.overview || '',
    airDate: date(e.air_date),
    runtime: e.runtime || null,
    stillPath: e.still_path || null,
    voteAverage: e.vote_average || 0,
    voteCount: e.vote_count || 0,
    crew: (e.crew || []).map(crew),
    guestStars: (e.guest_stars || []).map(cast)
  };
}

// ── checks ──────────────────────────────────────────────────────────────────

function mediaType(value) {
  if (value !== 'movie' && value !== 'tv') {
    throw errors.invalid('mediaType must be movie or tv');
  }
  return value;
}

function id(value, name) {
  var n = Number(value);
  if (!/^\d+$/.test(String(value)) || n < 1) {
    throw errors.invalid(name + ' must be a positive whole number');
  }
  return n;
}

function pageNumber(value) {
  if (value === undefined || value === '') {
    return 1;
  }
  var n = Number(value);
  if (!/^\d+$/.test(String(value)) || n < 1 || n > MAX_PAGE) {
    throw errors.invalid('page must be a whole number from 1 to ' + MAX_PAGE);
  }
  return n;
}

function optional(value, pattern, message) {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw errors.invalid(message);
  }
  return value;
}

// TMDB's failures in our words: its 404 → NOT_FOUND, anything else UPSTREAM
// (the message names no URL: it would carry the key)
function upstream(err) {
  var status = err && err.response && err.response.status;
  if (status === 404) {
    return errors.notFound('TMDB has no such title');
  }
  var e = new Error('TMDB: ' + (status ? 'HTTP ' + status : (err && err.code) || 'no answer'));
  e.code = 'UPSTREAM';
  e.status = 502;
  return e;
}

function ask(path, params, ttl) {
  var language = settings.get('metadata.language');
  return tmdb.get(path, Object.assign({ language: language }, params), ttl ? { ttl: ttl } : undefined)
    .catch(function (err) { throw upstream(err); });
}

function region(params) {
  var r = settings.get('metadata.region');
  if (r) {
    params.region = r;
  }
  return params;
}

// ── the catalog ─────────────────────────────────────────────────────────────

function info() {
  return {
    provider: 'tmdb',
    imageBase: IMAGE_BASE,
    language: settings.get('metadata.language'),
    region: settings.get('metadata.region') || null
  };
}

function genres(kind) {
  return ask('/genre/' + mediaType(kind) + '/list', {}).then(function (data) {
    return { genres: (data.genres || []).map(function (g) { return { id: g.id, name: g.name }; }) };
  });
}

/** One of TMDB's lists (popular, top rated, trending…) */
function list(kind, name, query) {
  kind = mediaType(kind);
  var path = LISTS[kind][name];
  if (!path) {
    throw errors.invalid('list must be one of ' + Object.keys(LISTS[kind]).join(', '));
  }
  var params = { page: pageNumber(query.page) };
  if (kind === 'movie') {
    region(params);
  }
  return ask(path, params, LIST_TTL).then(function (data) {
    return page(data, function (r) { return title(kind, r); });
  });
}

var SORTS = { popularity: 'popularity.desc', rating: 'vote_average.desc', newest: null };

/**
 * Titles by filters: sort (popularity | rating | newest), genres /
 * withoutGenres (TMDB genre ids, `,` = and, `|` = or), language (original,
 * ISO 639-1), minVotes, minRating, from / to (release or first air dates)
 */
function discover(kind, query) {
  kind = mediaType(kind);
  var released = kind === 'tv' ? 'first_air_date' : 'primary_release_date',
    sort = query.sort || 'popularity';
  if (!Object.prototype.hasOwnProperty.call(SORTS, sort)) {
    throw errors.invalid('sort must be popularity, rating or newest');
  }
  var params = {
      page: pageNumber(query.page),
      sort_by: SORTS[sort] || released + '.desc',
      include_adult: false
    },
    GENRES = /^\d+([,|]\d+)*$/,
    DAY = /^\d{4}-\d{2}-\d{2}$/;
  var set = function (key, value) {
    if (value !== undefined) {
      params[key] = value;
    }
  };
  set('with_genres', optional(query.genres, GENRES, 'genres must be TMDB genre ids'));
  set('without_genres', optional(query.withoutGenres, GENRES, 'withoutGenres must be TMDB genre ids'));
  set('with_original_language', optional(query.language, /^[a-z]{2}$/, 'language must be an ISO 639-1 code'));
  set('vote_count.gte', optional(query.minVotes, /^\d+$/, 'minVotes must be a whole number'));
  set('vote_average.gte', optional(query.minRating, /^\d+(\.\d+)?$/, 'minRating must be a number'));
  set(released + '.gte', optional(query.from, DAY, 'from must be a date (YYYY-MM-DD)'));
  set(released + '.lte', optional(query.to, DAY, 'to must be a date (YYYY-MM-DD)'));
  if (kind === 'movie') {
    region(params);
  }
  return ask('/discover/' + kind, params, LIST_TTL).then(function (data) {
    return page(data, function (r) { return title(kind, r); });
  });
}

/** Search: movies, shows, people, or all three (`multi`) */
function search(kind, query) {
  if (SEARCH_KINDS.indexOf(kind) === -1) {
    throw errors.invalid('kind must be one of ' + SEARCH_KINDS.join(', '));
  }
  var q = typeof query.q === 'string' ? query.q.trim() : '';
  if (!q || q.length > 200) {
    throw errors.invalid('q must be 1 to 200 characters');
  }
  return ask('/search/' + kind, { query: q, page: pageNumber(query.page), include_adult: false }, LIST_TTL)
    .then(function (data) {
      return page(data, function (r) {
        var type = kind === 'multi' ? r.media_type : kind;
        if (type === 'person') {
          return person(r);
        }
        return type === 'movie' || type === 'tv' ? title(type, r) : null;
      });
    });
}

function titleDetails(kind, tmdbId) {
  kind = mediaType(kind);
  return ask('/' + kind + '/' + id(tmdbId, 'tmdbId'), { append_to_response: 'external_ids,videos' })
    .then(function (data) { return details(kind, data); });
}

function credits(kind, tmdbId) {
  kind = mediaType(kind);
  return ask('/' + kind + '/' + id(tmdbId, 'tmdbId') + '/credits', {}).then(function (data) {
    return { cast: (data.cast || []).map(cast), crew: (data.crew || []).map(crew) };
  });
}

function similar(kind, tmdbId, query) {
  kind = mediaType(kind);
  return ask('/' + kind + '/' + id(tmdbId, 'tmdbId') + '/similar', { page: pageNumber(query.page) }, LIST_TTL)
    .then(function (data) { return page(data, function (r) { return title(kind, r); }); });
}

function season(tmdbId, number) {
  var show = id(tmdbId, 'tmdbId');
  if (!/^\d+$/.test(String(number))) {
    throw errors.invalid('season must be a whole number');
  }
  return ask('/tv/' + show + '/season/' + Number(number), {}).then(function (d) {
    return {
      tmdbId: show,
      seasonNumber: d.season_number,
      name: d.name || '',
      overview: d.overview || '',
      airDate: date(d.air_date),
      posterPath: d.poster_path || null,
      episodes: (d.episodes || []).map(episode)
    };
  });
}

/** A person's movies and shows: as cast (with the character) and crew (job) */
function personCredits(personId) {
  return ask('/person/' + id(personId, 'personId') + '/combined_credits', {}).then(function (d) {
    var titles = function (role) {
      return function (c) {
        if (c.media_type !== 'movie' && c.media_type !== 'tv') {
          return null;
        }
        return Object.assign(title(c.media_type, c), role(c));
      };
    };
    return {
      cast: (d.cast || []).map(titles(function (c) { return { character: c.character || null }; })).filter(Boolean),
      crew: (d.crew || []).map(titles(function (c) { return { job: c.job || null, department: c.department || null }; })).filter(Boolean)
    };
  });
}

// ── metadata providers (docs/providers-plan.md §7.2, step 7) ────────────────

// Plugin ids in the admin's order (Settings › Metadata: `metadata.order`
// first, the others by id)
function ordered(ids) {
  var order = settings.get('metadata.order');
  return ids.slice().sort(function (a, b) {
    var i = order.indexOf(a), j = order.indexOf(b);
    if (i === -1 && j === -1) {
      return a < b ? -1 : a > b ? 1 : 0;
    }
    return i === -1 ? 1 : j === -1 ? -1 : i - j;
  });
}

/** The metadata providers a profile gets, in order: [{ id, name, details, title }] (which hooks it has) */
function providers(ctx) {
  var plugins = require('./plugins'),
    off = settings.get('metadata.disabled'),
    found = {};
  ['metadata.details', 'metadata.title'].forEach(function (hook) {
    plugins.withHook(hook, ctx).forEach(function (p) {
      if (off.indexOf(p.id) === -1) {
        found[p.id] = found[p.id] || { id: p.id, name: p.name, details: false, title: false };
        found[p.id][hook === 'metadata.details' ? 'details' : 'title'] = true;
      }
    });
  });
  return ordered(Object.keys(found)).map(function (id) { return found[id]; });
}

/**
 * What metadata providers add to a title's page, per profile (ctx: the hook's
 * { profile, device, locale }): every enabled plugin with `metadata.details`
 * (ratings, tags, links, lines) or the older `metadata.title` (its `meta`, as
 * `lines`) in the admin's order, switched-off ones left out. Additions only
 * (decision I): the core's fields are never overridden. A plugin that fails
 * or is late only leaves itself out (`errors`).
 */
function extras(kind, tmdbId, ctx) {
  kind = mediaType(kind);
  var n = id(tmdbId, 'tmdbId'),
    plugins = require('./plugins'),
    list = providers(ctx);
  if (!list.length) {
    return Promise.resolve({ providers: [], errors: [] });
  }
  var off = settings.get('metadata.disabled');
  return titleDetails(kind, n).then(function (d) {
    var year = d.year ? Number(d.year) : null,
      title = { kind: kind === 'tv' ? 'show' : 'movie', tmdbId: n },
      details = { title: d.title.slice(0, 200), genres: d.genres.map(function (g) { return g.name; }) };
    if (d.imdbId) {
      title.imdbId = details.imdbId = d.imdbId;
    }
    if (d.title) {
      title.title = d.title.slice(0, 200);
    }
    if (year) {
      title.year = details.year = year;
    }
    if (d.originalTitle) {
      details.originalTitle = d.originalTitle.slice(0, 200);
    }
    if (d.runtime) {
      details.runtime = d.runtime;
    }
    var none = Promise.resolve({ results: [], errors: [] });
    return Promise.all([
      list.some(function (p) { return p.details; }) ? plugins.runHook('metadata.details', { title: title, details: details }, ctx, { except: off }) : none,
      // a plugin answering both: its metadata.details only
      list.some(function (p) { return p.title && !p.details; }) ? plugins.runHook('metadata.title', { title: title }, ctx, {
        except: off.concat(list.filter(function (p) { return p.details; }).map(function (p) { return p.id; }))
      }) : none
    ]);
  }).then(function (runs) {
    var answers = {};
    runs[0].results.forEach(function (r) { answers[r.plugin] = r.output; });
    runs[1].results.forEach(function (r) { answers[r.plugin] = { lines: r.output.meta || [] }; });
    return {
      providers: list.filter(function (p) { return answers[p.id]; }).map(function (p) {
        var a = answers[p.id];
        return {
          plugin: p.id,
          name: p.name,
          ratings: (a.ratings || []).map(function (r) {
            return { source: r.source, value: r.value, max: r.max, votes: r.votes === undefined ? null : r.votes, url: r.url || null };
          }),
          tags: a.tags || [],
          links: a.links || [],
          lines: a.lines || []
        };
      }).filter(function (p) {
        return p.ratings.length || p.tags.length || p.links.length || p.lines.length;
      }),
      errors: runs[0].errors.concat(runs[1].errors).map(function (e) { return { plugin: e.plugin, code: e.code }; })
    };
  });
}

module.exports = {
  info: info,
  genres: genres,
  list: list,
  discover: discover,
  search: search,
  details: titleDetails,
  credits: credits,
  similar: similar,
  season: season,
  personCredits: personCredits,
  providers: providers,
  extras: extras,
  LISTS: LISTS,
  // shapes, for tests and plugins' additions (step 7)
  shapes: { title: title, details: details, episode: episode }
};
