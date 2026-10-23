'use strict';

// The internal events of changes to a profile's data (docs/plugins-plan.md
// §4.4): watchlist.added / removed, watched.set / cleared, rating.set.
// Published in-process only (events.publish … { internal: true }): the
// plugins' event bus (lib/plugins/bus.js) reads them; clients never get them.
// `by` is who made the change: 'user' (a client), or 'plugin:<id>' (a
// plugin's write), so a plugin's own writes never come back to it.

/** A title as plugins see it (`titleRef`) from the core's mediaType / tmdbId (+ season / episode) */
function titleRef(item) {
  var episode = item.mediaType === 'tv' && item.season > 0 && item.episode > 0,
    ref = { kind: item.mediaType === 'movie' ? 'movie' : episode ? 'episode' : 'show', tmdbId: item.tmdbId };
  if (episode) {
    ref.season = item.season;
    ref.episode = item.episode;
  }
  if (typeof item.title === 'string' && item.title) {
    ref.title = item.title.slice(0, 200);
  }
  return ref;
}

/** A publisher for a service: changes(name, profileId, item, by, extra) */
module.exports = function changes(publish) {
  return function (name, profileId, item, by, extra) {
    if (!publish) {
      return;
    }
    publish(name, Object.assign({ profileId: profileId, title: titleRef(item), by: by || 'user' }, extra || {}), { internal: true });
  };
};

module.exports.titleRef = titleRef;
