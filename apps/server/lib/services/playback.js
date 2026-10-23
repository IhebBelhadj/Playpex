'use strict';

// Resume points, "Continue watching" and the watch history.
//
// The player reports its position periodically (saveProgress). A view counts as
// finished at FINISHED_RATIO; the first time an item becomes finished it is
// appended to the history, which feeds recommendations.

var validate = require('./validate'),
  errors = require('./errors'),
  changes = require('./changes');

var RESUME_MIN_RATIO = 0.05,   // below: start from the beginning
  FINISHED_RATIO = 0.9,        // at or above: finished (credits)
  RECENT_SCAN = 500;

function ratio(p) {
  return p.durationS > 0 ? Math.min(1, p.positionS / p.durationS) : 0;
}

// A save without title/artwork (e.g. "mark as watched" from a bare request)
// keeps what is already stored
function keepKnown(record, previous) {
  if (previous) {
    ['title', 'posterPath', 'backdropPath'].forEach(function (field) {
      if (record[field] == null) record[field] = previous[field];
    });
  }
  return record;
}

// History rows get the same title/artwork as the progress row
function withArtwork(input, record) {
  return Object.assign({}, input, { title: record.title, posterPath: record.posterPath, backdropPath: record.backdropPath });
}

function titleKey(p) {
  return p.mediaType + ':' + p.tmdbId;
}

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ profiles: object, now?: function(): Date }} options
 */
module.exports = function playbackService(repositories, options) {
  var progress = repositories.progress,
    history = repositories.history,
    profiles = options.profiles,
    changed = changes(options.publish),
    now = options.now || function () { return new Date(); };

  function withProfile(profileId, work) {
    return profiles.requireProfile(profileId).then(work);
  }

  function logView(profileId, key, input, watchedRatio, at) {
    return history.add({
      profileId: profileId,
      mediaType: key.mediaType,
      tmdbId: key.tmdbId,
      season: key.season,
      episode: key.episode,
      title: validate.optionalString(input.title, 'title'),
      posterPath: validate.optionalString(input.posterPath, 'posterPath'),
      backdropPath: validate.optionalString(input.backdropPath, 'backdropPath'),
      genreIds: validate.genreIds(input.genreIds),
      watchedRatio: watchedRatio,
      watchedAt: at
    });
  }

  return {
    RESUME_MIN_RATIO: RESUME_MIN_RATIO,
    FINISHED_RATIO: FINISHED_RATIO,

    /**
     * Record the playback position.
     * @param {{ mediaType, tmdbId, season?, episode?, positionS, durationS,
     *           title?, posterPath?, backdropPath?, genreIds?, infoHash?, filePath?, fileId? }} input
     *        (the release that plays: a torrent's infoHash + filePath, or a library file's fileId)
     * @returns {Promise<{ progress: object, finished: boolean, justFinished: boolean }>}
     */
    saveProgress: function (profileId, input) {
      input = input || {};
      return withProfile(profileId, function () {
        var key = validate.episodeKey(input),
          durationS = validate.nonNegativeNumber(input.durationS, 'durationS'),
          positionS = Math.min(validate.nonNegativeNumber(input.positionS, 'positionS'), durationS);
        if (!durationS) {
          throw errors.invalid('durationS must be greater than 0');
        }
        var at = now(),
          record = Object.assign({ profileId: profileId }, key, {
            title: validate.optionalString(input.title, 'title'),
            posterPath: validate.optionalString(input.posterPath, 'posterPath'),
            backdropPath: validate.optionalString(input.backdropPath, 'backdropPath'),
            positionS: positionS,
            durationS: durationS,
            infoHash: validate.optionalString(input.infoHash, 'infoHash', 64),
            filePath: validate.optionalString(input.filePath, 'filePath', 1000),
            fileId: validate.optionalString(input.fileId, 'fileId', 64),
            updatedAt: at
          });
        record.finished = ratio(record) >= FINISHED_RATIO;

        return progress.find(profileId, key).then(function (previous) {
          var justFinished = record.finished && !(previous && previous.finished);
          keepKnown(record, previous);
          return progress.upsert(record).then(function (saved) {
            return justFinished ? logView(profileId, key, withArtwork(input, record), ratio(record), at).then(function () { return saved; }) : saved;
          }).then(function (saved) {
            return { progress: saved, finished: saved.finished, justFinished: justFinished };
          });
        });
      });
    },

    /**
     * State of a movie / episode for its detail page and the player:
     * { resume: <getResume result>|null, finished: boolean }
     */
    getState: function (profileId, keyInput) {
      return withProfile(profileId, function () {
        return progress.find(profileId, validate.episodeKey(keyInput));
      }).then(function (p) {
        var resumable = p && !p.finished && ratio(p) >= RESUME_MIN_RATIO;
        return {
          resume: resumable ? { positionS: p.positionS, durationS: p.durationS, infoHash: p.infoHash, filePath: p.filePath, fileId: p.fileId, updatedAt: p.updatedAt } : null,
          finished: !!(p && p.finished)
        };
      });
    },

    /**
     * Where to resume a movie / episode, or null to start from the beginning.
     * Includes the release (infoHash + filePath, or fileId) that was playing.
     */
    getResume: function (profileId, keyInput) {
      return withProfile(profileId, function () {
        return progress.find(profileId, validate.episodeKey(keyInput));
      }).then(function (p) {
        if (!p || p.finished || ratio(p) < RESUME_MIN_RATIO) {
          return null;
        }
        return { positionS: p.positionS, durationS: p.durationS, infoHash: p.infoHash, filePath: p.filePath, fileId: p.fileId, updatedAt: p.updatedAt };
      });
    },

    /**
     * The "Continue watching" row, newest first, one entry per title:
     *   kind 'resume'  unfinished movie/episode; resume at positionS (0 = start over)
     *   kind 'next'    the last watched episode of a show is finished; the UI
     *                  resolves the following episode (season/episode are the finished one)
     * Movies that were only started (< RESUME_MIN_RATIO) or finished are left out.
     */
    continueWatching: function (profileId, filter) {
      filter = filter || {};
      return withProfile(profileId, function () {
        var limit = validate.limit(filter.limit, 20, 100);
        return progress.listRecent(profileId, { limit: RECENT_SCAN }).then(function (rows) {
          var seen = new Set(), items = [];
          rows.forEach(function (p) {
            if (items.length >= limit || seen.has(titleKey(p))) {
              return;
            }
            seen.add(titleKey(p));
            var r = ratio(p);
            if (p.mediaType === 'movie' && (p.finished || r < RESUME_MIN_RATIO)) {
              return;
            }
            items.push({
              kind: p.finished ? 'next' : 'resume',
              mediaType: p.mediaType,
              tmdbId: p.tmdbId,
              season: p.season,
              episode: p.episode,
              title: p.title,
              posterPath: p.posterPath,
              backdropPath: p.backdropPath,
              positionS: !p.finished && r >= RESUME_MIN_RATIO ? p.positionS : 0,
              durationS: p.durationS,
              ratio: r,
              infoHash: p.infoHash,
              filePath: p.filePath,
              fileId: p.fileId,
              updatedAt: p.updatedAt
            });
          });
          return items;
        });
      });
    },

    /** Progress of every episode of a show (or the movie), to mark watched episodes */
    titleProgress: function (profileId, refInput) {
      return withProfile(profileId, function () {
        return progress.listForTitle(profileId, validate.mediaRef(refInput));
      }).then(function (rows) {
        return rows.map(function (p) {
          return { season: p.season, episode: p.episode, positionS: p.positionS, durationS: p.durationS, ratio: ratio(p), finished: p.finished, updatedAt: p.updatedAt };
        });
      });
    },

    /** Mark as watched without playing it (logged in the history like a real view); by: 'user' or 'plugin:<id>' */
    markWatched: function (profileId, input, by) {
      input = input || {};
      return withProfile(profileId, function () {
        var key = validate.episodeKey(input),
          durationS = input.durationS == null ? 0 : validate.nonNegativeNumber(input.durationS, 'durationS'),
          // when it was watched (a plugin's sync), never in the future
          at = input.at && !isNaN(Date.parse(input.at)) ? new Date(Math.min(Date.parse(input.at), now().getTime())) : now();
        return progress.find(profileId, key).then(function (previous) {
          var record = keepKnown(Object.assign({ profileId: profileId }, key, {
            title: validate.optionalString(input.title, 'title'),
            posterPath: validate.optionalString(input.posterPath, 'posterPath'),
            backdropPath: validate.optionalString(input.backdropPath, 'backdropPath'),
            positionS: durationS,
            durationS: durationS,
            infoHash: previous ? previous.infoHash : null,
            filePath: previous ? previous.filePath : null,
            fileId: previous ? previous.fileId : null,
            finished: true,
            updatedAt: at
          }), previous);
          return progress.upsert(record).then(function (saved) {
            if (previous && previous.finished) {
              return saved;
            }
            return logView(profileId, key, withArtwork(input, record), 1, at).then(function () {
              changed('watched.set', profileId, Object.assign({}, key, { title: record.title }), by);
              return saved;
            });
          });
        });
      });
    },

    /** Forget the resume point / watched state. The history log is kept. */
    markUnwatched: function (profileId, keyInput, by) {
      return withProfile(profileId, function () {
        var key = validate.episodeKey(keyInput);
        return progress.remove(profileId, key).then(function (removed) {
          if (removed) {
            changed('watched.cleared', profileId, key, by);
          }
          return removed;
        });
      });
    },

    /**
     * The "Watched" row: one entry per title, newest first, from the history.
     * For shows: the latest episode watched and how many distinct episodes.
     */
    watchedTitles: function (profileId, filter) {
      filter = filter || {};
      return withProfile(profileId, function () {
        var limit = validate.limit(filter.limit, 50, 200);
        return history.list(profileId, { limit: 2000 }).then(function (entries) {
          var titles = new Map();
          entries.forEach(function (h) {
            var k = titleKey(h), t = titles.get(k);
            if (!t) {
              if (titles.size >= limit) return;
              t = {
                mediaType: h.mediaType, tmdbId: h.tmdbId, title: h.title,
                posterPath: h.posterPath, backdropPath: h.backdropPath,
                season: h.season, episode: h.episode, watchedAt: h.watchedAt,
                episodes: new Set()
              };
              titles.set(k, t);
            }
            // older rows may lack artwork
            t.posterPath = t.posterPath || h.posterPath;
            t.backdropPath = t.backdropPath || h.backdropPath;
            if (h.mediaType === 'tv') t.episodes.add(h.season + 'x' + h.episode);
          });
          return Array.from(titles.values()).map(function (t) {
            var episodes = t.episodes.size;
            delete t.episodes;
            if (t.mediaType === 'tv') t.episodesWatched = episodes;
            return t;
          });
        });
      });
    },

    /** Finished views, newest first */
    history: function (profileId, filter) {
      filter = filter || {};
      return withProfile(profileId, function () {
        return history.list(profileId, {
          mediaType: filter.mediaType ? validate.mediaType(filter.mediaType) : undefined,
          limit: validate.limit(filter.limit, 50, 500)
        });
      });
    }
  };
};
