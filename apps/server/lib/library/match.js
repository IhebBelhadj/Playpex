'use strict';

// What a parsed file is on TMDB (docs/media-server-plan.md §5.2): ids from
// .nfo files (or {tmdb-…} / {imdb-…} tags in the name) first, else a search
// by title and year, kept only above a confidence score. Episodes: the show,
// then the episode in its season.
//
//   match(parsed, nfo, folderKind, catalog) → Promise<{ identity, details, matchedBy, score } | null>
//   catalog: lib/tmdb.js (search, movie, tv, season, find); rejects on network
//   errors (the file stays unmatched and is tried again on a later scan).

var CONFIDENCE = 0.8;

// lowercase, no accents, "&" = "and", punctuation dropped
function normalize(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function bigrams(text) {
  var s = text.replace(/ /g, ''), out = [];
  for (var i = 0; i < s.length - 1; i++) {
    out.push(s.slice(i, i + 2));
  }
  return out;
}

// 1 for the same words, else Dice's coefficient on letter pairs; a leading
// "the" doesn't count
function similarity(a, b) {
  a = normalize(a).replace(/^the /, '');
  b = normalize(b).replace(/^the /, '');
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  var x = bigrams(a), y = bigrams(b), hits = 0;
  if (!x.length || !y.length) {
    return 0;
  }
  var pool = y.slice();
  x.forEach(function (pair) {
    var at = pool.indexOf(pair);
    if (at !== -1) {
      hits++;
      pool.splice(at, 1);
    }
  });
  return 2 * hits / (x.length + y.length);
}

function yearOf(date) {
  return date ? parseInt(String(date).slice(0, 4), 10) || null : null;
}

// The best result for `title` (+ year): { result, score } or null
function best(results, title, year, names) {
  var top = null;
  results.forEach(function (r, rank) {
    var sim = Math.max.apply(null, names(r).map(function (n) { return similarity(title, n); })),
      released = yearOf(r.release_date || r.first_air_date),
      score = sim;
    if (year && released) {
      score -= released === year ? 0 : Math.abs(released - year) === 1 ? 0.05 : 0.3;
    } else if (year) {
      score -= 0.1;
    }
    score -= rank * 0.001;   // TMDB's order breaks ties
    if (!top || score > top.score) {
      top = { result: r, score: score };
    }
  });
  return top && top.score >= CONFIDENCE ? top : null;
}

function movieDetails(m) {
  return {
    tmdbId: m.id,
    imdbId: m.imdb_id || m.external_ids && m.external_ids.imdb_id || null,
    title: m.title || null,
    year: yearOf(m.release_date),
    artwork: { posterPath: m.poster_path || null, backdropPath: m.backdrop_path || null, stillPath: null }
  };
}

function movieById(catalog, tmdbId, imdbId) {
  if (tmdbId) {
    return catalog.movie(tmdbId);
  }
  return catalog.find(imdbId).then(function (found) {
    var m = (found.movie_results || [])[0];
    return m ? catalog.movie(m.id) : null;
  });
}

function matchMovie(parsed, nfo, catalog) {
  var tmdbId = nfo.tmdbId || (parsed.tmdbId ? parseInt(parsed.tmdbId, 10) : null),
    imdbId = nfo.imdbId || parsed.imdbId;
  if (tmdbId || imdbId) {
    return movieById(catalog, tmdbId, imdbId).then(function (m) {
      return m ? { identity: { kind: 'movie', tmdbId: m.id }, details: movieDetails(m), matchedBy: 'nfo', score: 1 } : null;
    }, notFound);
  }
  if (!parsed.title) {
    return Promise.resolve(null);
  }
  function names(r) {
    return [r.title, r.original_title].filter(Boolean);
  }
  return catalog.search('movie', parsed.title, parsed.year).then(function (results) {
    var found = best(results, parsed.title, parsed.year, names);
    if (found || !parsed.year) {
      return found;
    }
    // a year one off (festival vs. release) is only found without it
    return catalog.search('movie', parsed.title).then(function (all) {
      return best(all, parsed.title, parsed.year, names);
    });
  }).then(function (found) {
    if (!found) {
      return null;
    }
    return catalog.movie(found.result.id).then(function (m) {
      return { identity: { kind: 'movie', tmdbId: m.id }, details: movieDetails(m), matchedBy: 'auto', score: found.score };
    });
  });
}

// The show: { show, by } or null
function findShow(parsed, nfo, catalog) {
  if (nfo.showTmdbId) {
    return catalog.tv(nfo.showTmdbId).then(function (show) { return { show: show, by: 'nfo' }; });
  }
  if (nfo.showImdbId) {
    return catalog.find(nfo.showImdbId).then(function (found) {
      var s = (found.tv_results || [])[0];
      return s ? catalog.tv(s.id).then(function (show) { return { show: show, by: 'nfo' }; }) : null;
    });
  }
  if (!parsed.title) {
    return Promise.resolve(null);
  }
  function names(r) {
    return [r.name, r.original_name].filter(Boolean);
  }
  // "The Office US": TMDB names it "The Office", from the US
  var country = parsed.title.match(/^(.+?)\s+(us|uk|au|nz|ca)$/i);
  function search(title, year, origin) {
    return catalog.search('tv', title, year).then(function (results) {
      if (origin) {
        results = results.filter(function (r) {
          return (r.origin_country || []).indexOf(origin === 'UK' ? 'GB' : origin) !== -1;
        });
      }
      return best(results, title, year, names);
    });
  }
  var attempts = [function () { return search(parsed.title, parsed.year); }];
  if (country) {
    attempts.push(function () { return search(country[1], parsed.year, country[2].toUpperCase()); });
  }
  if (parsed.year) {
    attempts.push(function () { return search(parsed.title, null); });
  }
  return attempts.reduce(function (chain, attempt) {
    return chain.then(function (found) { return found || attempt(); });
  }, Promise.resolve(null)).then(function (found) {
    return found ? catalog.tv(found.result.id).then(function (show) { return { show: show, by: 'auto', score: found.score }; }) : null;
  });
}

function matchEpisode(parsed, nfo, catalog) {
  var season = nfo.season !== null ? nfo.season : parsed.season,
    episode = nfo.episode !== null ? nfo.episode : parsed.episode;
  if (season === null || season === undefined || !episode) {
    return Promise.resolve(null);
  }
  return findShow(parsed, nfo, catalog).then(function (found) {
    if (!found) {
      return null;
    }
    return episodeOfShow(catalog, found.show, season, episode).then(function (details) {
      return details ? {
        identity: { kind: 'episode', showTmdbId: found.show.id, season: season, episode: episode },
        details: details,
        matchedBy: found.by,
        score: found.score || 1
      } : null;
    });
  });
}

// An episode's details from its show's season, or null (no such season / episode)
function episodeOfShow(catalog, show, season, episode) {
  return catalog.season(show.id, season).then(function (s) {
    var ep = (s.episodes || []).filter(function (e) { return e.episode_number === episode; })[0];
    if (!ep) {
      return null;
    }
    return {
      tmdbId: ep.id,
      imdbId: show.external_ids && show.external_ids.imdb_id || null,   // the show's
      title: show.name || null,
      episodeTitle: ep.name || null,
      year: yearOf(show.first_air_date),
      artwork: { posterPath: show.poster_path || null, backdropPath: show.backdrop_path || null, stillPath: ep.still_path || null }
    };
  }, notFound);
}

function notFound(err) {
  if (err.response && err.response.status === 404) {
    return null;
  }
  throw err;
}

/**
 * The details of an identity the admin chose (PUT …/match), null when TMDB
 * has no such movie / episode.
 * @param {{ kind, tmdbId?, showTmdbId?, season?, episode? }} identity
 */
function describe(identity, catalog) {
  if (identity.kind === 'movie') {
    return catalog.movie(identity.tmdbId).then(movieDetails, notFound);
  }
  return catalog.tv(identity.showTmdbId).then(function (show) {
    return episodeOfShow(catalog, show, identity.season, identity.episode);
  }, notFound);
}

/**
 * @param {object} parsed      lib/library/parse.js
 * @param {object} nfo         lib/library/nfo.js#read
 * @param {string} folderKind  movies · shows · mixed · other (other: never matched)
 * @param {object} catalog     lib/tmdb.js
 */
function match(parsed, nfo, folderKind, catalog) {
  var kind = parsed.kind;
  if (nfo.showTmdbId || nfo.showImdbId) {
    kind = 'episode';
  } else if (nfo.tmdbId || nfo.imdbId) {
    kind = 'movie';
  }
  if (folderKind === 'other' || folderKind === 'movies' && kind !== 'movie' || folderKind === 'shows' && kind !== 'episode') {
    return Promise.resolve(null);
  }
  return kind === 'episode' ? matchEpisode(parsed, nfo, catalog) : kind === 'movie' ? matchMovie(parsed, nfo, catalog) :
    Promise.resolve(null);
}

module.exports = {
  match: match,
  describe: describe,
  similarity: similarity,
  normalize: normalize,
  CONFIDENCE: CONFIDENCE
};
