'use strict';

// Writes to the user's data (docs/plugins-plan.md §4.6), the host API parts
// behind `permissions.write`, through the core's services so every rule of the
// core applies and every write is an event with `by: 'plugin:<id>'` (never
// sent back to its writer, lib/plugins/bus.js):
//
//   watchlist.add / remove / list (profileId, title)          write: watchlist
//   watched.set (profileId, title, { at? }) / watched.clear   write: watched (history + watched mark)
//   progress.set (profileId, title, position, duration, { at? })   write: watched (only if newer than the core's)
//   ratings.set (profileId, title, 1–10) / ratings.clear      write: ratings (the core keeps likes: 6–10 like, 1–5 dislike)
//   downloads.add ({ magnet | url | infoHash, title, ref? }) / downloads.list ()   write: downloads (its own only)
//   profiles.list (permission?)                                the profiles granted that personal permission
//
// The personal scopes (watchlist, watched, ratings) only for profiles the
// admin granted `write.<scope>` (dashboard, decision G); `adults` plugins only
// have `downloads` and never see a kids profile. Titles are titleRefs with a
// TMDB id (`kind` movie, show or episode); the poster comes from TMDB when the
// server has a key, so rows render like the core's.

var schemas = require('./schemas'),
  changes = require('../services/changes');

var PERSONAL_SCOPES = ['watchlist', 'watched', 'ratings'];

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function denied(message) {
  return Promise.reject(failure('PERMISSION_DENIED', message));
}

/** A titleRef the core can store: { mediaType, tmdbId, season?, episode?, title? } */
function itemOf(title, wholeShow) {
  var problem = schemas.apiProblem('titleRef', title || null);
  if (problem) {
    throw failure('INVALID', 'title: ' + problem);
  }
  if (!title.tmdbId || title.kind === 'video') {
    throw failure('INVALID', 'title: a movie, show or episode with its tmdbId');
  }
  var item = { mediaType: title.kind === 'movie' ? 'movie' : 'tv', tmdbId: title.tmdbId };
  if (title.kind === 'episode' && !wholeShow) {
    item.season = title.season;
    item.episode = title.episode;
  }
  if (title.title) {
    item.title = title.title;
  }
  return item;
}

// Poster and backdrop from TMDB (best effort: rows render without them too)
function artwork(item) {
  var tmdb = require('../tmdb');
  var fetch = item.mediaType === 'movie' ? tmdb.movie : tmdb.tv;
  if (typeof fetch !== 'function') {
    return Promise.resolve(item);
  }
  return Promise.resolve().then(function () { return fetch(item.tmdbId); }).then(function (d) {
    return Object.assign({}, item, {
      title: item.title || d.title || d.name || null,
      posterPath: d.poster_path || null,
      backdropPath: d.backdrop_path || null
    });
  }, function () {
    return item;
  });
}

function linkOf(request) {
  if (typeof request.magnet === 'string' && /^magnet:\?/i.test(request.magnet)) {
    return request.magnet;
  }
  if (typeof request.infoHash === 'string' && /^([0-9a-f]{40}|[A-Z2-7]{32})$/i.test(request.infoHash)) {
    return request.infoHash;
  }
  if (typeof request.url === 'string' && /^https:\/\//.test(request.url)) {
    return request.url;
  }
  return null;
}

/**
 * The host API's write parts for one plugin
 * @param {object} plugin  { id, manifest, permissions, stats }
 * @param {function(): Promise<object>} services userData.services
 */
module.exports = function writes(plugin, services) {
  var p = plugin.permissions,
    by = 'plugin:' + plugin.id,
    adults = plugin.manifest.audience === 'adults';

  function count(key) {
    plugin.stats.host[key] = (plugin.stats.host[key] || 0) + 1;
  }

  // The profile, if this plugin may write `scope` for it: { id, kids }
  function writable(scope, profileId) {
    if ((p.write || []).indexOf(scope) === -1) {
      return denied('writing ' + scope + ' needs write: [\'' + scope + '\']');
    }
    if (adults) {
      return denied('an adults plugin only writes downloads');
    }
    if (typeof profileId !== 'string' || !profileId) {
      return Promise.reject(failure('INVALID', 'a profile id'));
    }
    return services().then(function (s) {
      return Promise.all([s.profiles.get(profileId).catch(function () { return null; }), s.plugins.grants.byProfile(plugin.id)]);
    }).then(function (r) {
      if (!r[0]) {
        throw failure('NOT_FOUND', 'no profile ' + profileId);
      }
      if ((r[1][profileId] || []).indexOf('write.' + scope) === -1) {
        throw failure('PERMISSION_DENIED', 'this profile hasn\'t been granted write.' + scope + ' (the dashboard: Plugins › Settings › Profiles)');
      }
      count('write ' + scope);
      return { id: profileId };
    });
  }

  return {
    'profiles.list': function (args) {
      var permission = args.permission || null;
      if (permission !== null && protocol().PERSONAL.indexOf(permission) === -1) {
        return Promise.reject(failure('INVALID', 'permission must be one of ' + protocol().PERSONAL.join(', ')));
      }
      return services().then(function (s) {
        return Promise.all([s.profiles.list(), s.plugins.grants.byProfile(plugin.id)]);
      }).then(function (r) {
        var granted = r[1];
        return {
          value: r[0].filter(function (pr) {
            var g = granted[pr.id] || [];
            return !(adults && pr.isKid) && (permission ? g.indexOf(permission) !== -1 : g.length > 0);
          }).map(function (pr) { return { id: pr.id, kids: !!pr.isKid }; })
        };
      });
    },

    'watchlist.add': function (args) {
      return writable('watchlist', args.profileId).then(function () {
        return artwork(itemOf(args.title, true));
      }).then(function (item) {
        return services().then(function (s) { return s.watchlist.add(args.profileId, item, by); });
      }).then(function () { return { value: true }; });
    },
    'watchlist.remove': function (args) {
      return writable('watchlist', args.profileId).then(function () {
        var item = itemOf(args.title, true);
        return services().then(function (s) { return s.watchlist.remove(args.profileId, item, by); });
      }).then(function (removed) { return { value: !!removed }; });
    },
    'watchlist.list': function (args) {
      return writable('watchlist', args.profileId).then(function () {
        return services().then(function (s) { return s.watchlist.list(args.profileId, { limit: 500 }); });
      }).then(function (rows) {
        return { value: rows.map(function (r) {
          return { title: changes.titleRef(r), addedAt: r.addedAt instanceof Date ? r.addedAt.toISOString() : r.addedAt };
        }) };
      });
    },

    'watched.set': function (args) {
      return writable('watched', args.profileId).then(function () {
        return artwork(itemOf(args.title));
      }).then(function (item) {
        var at = args.options && args.options.at;
        if (at !== undefined && at !== null && isNaN(Date.parse(at))) {
          throw failure('INVALID', 'at must be a date');
        }
        return services().then(function (s) {
          return s.playback.markWatched(args.profileId, Object.assign({}, item, at ? { at: at } : {}), by);
        });
      }).then(function () { return { value: true }; });
    },
    'watched.clear': function (args) {
      return writable('watched', args.profileId).then(function () {
        var item = itemOf(args.title);
        return services().then(function (s) { return s.playback.markUnwatched(args.profileId, item, by); });
      }).then(function (removed) { return { value: !!removed }; });
    },
    'progress.set': function (args) {
      var position = args.position, duration = args.duration, at = args.options && args.options.at;
      if (!(typeof position === 'number' && position >= 0 && typeof duration === 'number' && duration > 0)) {
        return Promise.reject(failure('INVALID', 'position (≥ 0) and duration (> 0) in seconds'));
      }
      return writable('watched', args.profileId).then(function () {
        return artwork(itemOf(args.title));
      }).then(function (item) {
        return services().then(function (s) {
          return s.playback.getState(args.profileId, item).then(function (state) {
            var theirs = state.resume && state.resume.updatedAt ? new Date(state.resume.updatedAt).getTime() : 0;
            // the core's is newer: it stays
            if (theirs && (at ? Date.parse(at) : Date.now()) <= theirs) {
              return false;
            }
            return s.playback.saveProgress(args.profileId, Object.assign({}, item, { positionS: position, durationS: duration }), by)
              .then(function () { return true; });
          });
        });
      }).then(function (written) { return { value: written }; });
    },

    'ratings.set': function (args) {
      var value = args.value;
      if (!(Number.isInteger(value) && value >= 1 && value <= 10)) {
        return Promise.reject(failure('INVALID', 'a rating is a whole number from 1 to 10'));
      }
      return writable('ratings', args.profileId).then(function () {
        var item = itemOf(args.title, true);
        return services().then(function (s) { return s.ratings.rate(args.profileId, item, value >= 6 ? 1 : -1, by); });
      }).then(function () { return { value: true }; });
    },
    'ratings.clear': function (args) {
      return writable('ratings', args.profileId).then(function () {
        var item = itemOf(args.title, true);
        return services().then(function (s) { return s.ratings.clear(args.profileId, item, by); });
      }).then(function (removed) { return { value: !!removed }; });
    },

    'downloads.add': function (args) {
      if ((p.write || []).indexOf('downloads') === -1) {
        return denied('adding downloads needs write: [\'downloads\']');
      }
      var request = args || {}, link = linkOf(request);
      if (!link) {
        return Promise.reject(failure('INVALID', 'a magnet, an info hash or an https .torrent url'));
      }
      if (typeof request.title !== 'string' || !request.title || request.title.length > 300) {
        return Promise.reject(failure('INVALID', 'a title (the name shown in Downloads)'));
      }
      var ref = null;
      try {
        ref = request.ref ? itemOf(request.ref) : null;
      } catch (err) {
        return Promise.reject(err);
      }
      count('write downloads');
      var torrents = require('../torrents/client');
      return torrents.add(link, { intent: 'download', by: by }).then(function (infoHash) {
        if (ref) {
          torrents.describe(infoHash, { titleRef: Object.assign(ref, { title: request.title }) });
        }
        return { value: { infoHash: infoHash } };
      });
    },
    'downloads.list': function () {
      if ((p.write || []).indexOf('downloads') === -1) {
        return denied('downloads needs write: [\'downloads\']');
      }
      var torrents = require('../torrents/client');
      return Promise.resolve({ value: torrents.list().filter(function (d) { return d.addedBy === by; }).map(function (d) {
        return { infoHash: d.infoHash, name: d.name, state: d.state, progress: d.progress, sizeBytes: d.sizeBytes };
      }) });
    }
  };
};

function protocol() {
  return require('@playpex/protocol/plugins');
}

module.exports.PERSONAL_SCOPES = PERSONAL_SCOPES;
