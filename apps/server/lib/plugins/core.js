'use strict';

// Core data for plugins (docs/plugins-plan.md §4.2), the host API parts that
// read what the server already knows, through its own clients: a plugin needs
// no TMDB key of its own and no `permissions.network` for these.
//
//   tmdb.get ({ path, params })           TMDB's JSON for a catalog GET: the server's key, its 6 h cache (lib/tmdb.js)
//   imdb.title ({ id }) / imdb.episodes ({ id })   IMDb ratings (lib/imdb.js, cached 6 h)
//   library.find ({ title, profileId })   what's on this server for a titleRef (lib/library/view.js): counts, never
//                                         paths or refs; needs permissions.library
//
// Read-only: TMDB paths of the catalog only (movies, shows, people, search,
// discover…; no account, session or rating paths), never the key in an answer
// or an error. `include_adult` is only passed on for `audience: adults`
// plugins (the others get false: their screens reach kids profiles).
// Rate limited per plugin and service (LIMITS.core: waits, then RATE_LIMITED).
// Errors: PROVIDER_NOT_CONFIGURED (no TMDB key on this server), NOT_FOUND,
// UPSTREAM, INVALID, PERMISSION_DENIED.

var protocol = require('@playpex/protocol/plugins'),
  schemas = require('./schemas'),
  RateLimiter = require('./ratelimit'),
  tmdb = require('../tmdb'),
  imdb = require('../imdb'),
  view = require('../library/view');

var TMDB_PATH = /^\/(movie|tv|search|discover|find|person|company|collection|genre|configuration|trending|network|keyword|certification|watch|review|credit)(\/[A-Za-z0-9_-]+){0,6}$/,
  TMDB_NOT_READ = /\/(account_states|rating)(\/|$)/,
  PARAM_KEY = /^[a-z][a-z0-9_.]{0,39}$/,
  PARAM_NOT_PASSED = ['api_key', 'session_id', 'guest_session_id'],
  MAX_PARAMS = 30,
  IMDB_ID = /^tt\d{7,10}$/;

var limiter = new RateLimiter();

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function denied(message) {
  return Promise.reject(failure('PERMISSION_DENIED', message));
}

// An upstream failure in words the plugin may see (no URL: it holds the key)
function upstream(service, err) {
  if (err && err.code === 'PROVIDER_NOT_CONFIGURED') {
    return failure('PROVIDER_NOT_CONFIGURED', 'this server has no TMDB key (the dashboard\'s Settings)');
  }
  var status = err && err.response && err.response.status;
  if (status === 404) {
    return failure('NOT_FOUND', service + ': not found');
  }
  return failure('UPSTREAM', service + ': ' + (status ? 'HTTP ' + status : err && err.code || 'no answer'));
}

// TMDB query parameters: plain values under known-looking names, never ours
function tmdbParams(params, adults) {
  if (params === null || params === undefined) {
    params = {};
  }
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw failure('INVALID', 'params: an object');
  }
  var keys = Object.keys(params), out = {};
  if (keys.length > MAX_PARAMS) {
    throw failure('INVALID', 'params: at most ' + MAX_PARAMS);
  }
  keys.forEach(function (k) {
    var v = params[k];
    if (!PARAM_KEY.test(k) || PARAM_NOT_PASSED.indexOf(k) !== -1) {
      throw failure('INVALID', 'params: ' + k.slice(0, 40) + ' isn\'t allowed');
    }
    if (v === null || v === undefined) {
      return;
    }
    if (['string', 'number', 'boolean'].indexOf(typeof v) === -1 || String(v).length > 500) {
      throw failure('INVALID', 'params.' + k + ': a string, number or boolean (≤ 500 characters)');
    }
    out[k] = v;
  });
  if (!adults) {
    out.include_adult = false;
  }
  return out;
}

/**
 * @param {object} plugin  { id, manifest, permissions, stats }
 * @param {function(): Promise<object>} services userData.services
 */
module.exports = function core(plugin, services) {
  var p = plugin.permissions,
    adults = plugin.manifest.audience === 'adults';

  function count(key) {
    plugin.stats.host[key] = (plugin.stats.host[key] || 0) + 1;
  }

  // One call to a core service, inside this plugin's share of it
  function limited(service, work) {
    count(service);
    return limiter.acquire(plugin.id + ' ' + service, protocol.LIMITS.core).then(function (release) {
      return Promise.resolve().then(work).then(function (value) {
        release();
        return { value: value };
      }, function (err) {
        release();
        count(service + '.' + (err.code || 'error'));
        throw err;
      });
    });
  }

  function imdbCall(name) {
    return function (args) {
      var id = String(args.id || '');
      if (!IMDB_ID.test(id)) {
        return Promise.reject(failure('INVALID', 'id: an IMDb id (tt…)'));
      }
      return limited('imdb', function () {
        return imdb[name](id).catch(function (err) { throw upstream('IMDb', err); });
      });
    };
  }

  return {
    'tmdb.get': function (args) {
      var path = String(args.path || '');
      if (!TMDB_PATH.test(path) || TMDB_NOT_READ.test(path)) {
        return Promise.reject(failure('INVALID', 'path: a TMDB catalog path such as /movie/550 (got ' + path.slice(0, 80) + ')'));
      }
      var params = tmdbParams(args.params, adults);
      return limited('tmdb', function () {
        return tmdb.get(path, params).catch(function (err) { throw upstream('TMDB', err); });
      });
    },

    'imdb.title': imdbCall('title'),
    'imdb.episodes': imdbCall('episodes'),

    // A title on this server, as the profile may see it: a kids profile (or no
    // profile) never counts files of adults-only folders
    'library.find': function (args) {
      if (!p.library) {
        return denied('library.find needs permissions.library');
      }
      var title = args.title || null, problem = schemas.apiProblem('titleRef', title);
      if (!problem && (title.kind === 'video' || !title.tmdbId)) {
        problem = 'a movie, show or episode with its tmdbId';
      }
      if (!problem && title.kind === 'episode' && (title.season === undefined || title.episode === undefined)) {
        problem = 'an episode needs season and episode';
      }
      if (problem) {
        return Promise.reject(failure('INVALID', 'title: ' + problem));
      }
      count('library');
      return services().then(function (s) {
        var who = args.profileId ? s.profiles.get(args.profileId).then(function (profile) { return !!profile.isKid; }, function () {
          throw failure('NOT_FOUND', 'no profile ' + args.profileId);
        }) : Promise.resolve(true);
        return who.then(function (kid) {
          return view.title(s, title.kind === 'movie' ? 'movie' : 'tv', title.tmdbId, { kid: kid });
        });
      }).then(function (found) {
        if (title.kind === 'episode') {
          var episode = found.episodes.filter(function (e) { return e.season === title.season && e.episode === title.episode; });
          found.fileCount = episode.length ? episode[0].fileCount : 0;
          found.episodes = episode;
        }
        return { value: found };
      });
    }
  };
};

module.exports.reset = function () {
  limiter.reset();
};
