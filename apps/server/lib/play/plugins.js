'use strict';

// Plugins in the play pipeline (docs/plugins-plan.md §4.3, §4.7, step P3),
// through lib/plugins' hooks:
//   play.collect  a collect handler like the core's: a plugin's `magnet`
//                 sources become torrents, its `http` sources media refs
//                 r_… (lib/plugins/remote.js) of type `plugin`; every
//                 plugin's torrents ranked together, like the core's sites
//   play.resolve  check: which collected torrents a resolver (debrid) can
//                 serve at once (badge `cached`, ranked before the others);
//                 resolve: the chosen one as an http source, at start()
//   play.rank     after the core's ranking: order and hide, with a reason
//   play.before   at start(): continue, ask (the client asks, then starts
//                 again with `confirmed`) or refuse
//   player.markers  intro / recap / credits / chapters of what plays
// A plugin's failure only drops its part (lib/plugins#runHook skips it).

var crypto = require('crypto'),
  protocol = require('@playpex/protocol/plugins'),
  plugins = require('../plugins'),
  remote = require('../plugins/remote'),
  effects = require('../plugins/effects'),
  trackers = require('../trackers'),
  names = require('../media/names'),
  log = require('../logger').child('play');

var HOOKS = protocol.HOOKS,
  BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** What hooks get of the title asked for (`$defs/titleRef`) */
function titleRef(title) {
  var ref = { kind: title.kind, tmdbId: title.tmdbId, title: title.title.slice(0, 200) };
  if (title.imdbId) {
    ref.imdbId = title.imdbId;
  }
  if (title.year) {
    ref.year = title.year;
  }
  if (title.kind === 'episode') {
    ref.season = title.season;
    ref.episode = title.episode;
  }
  return ref;
}

/** What play.rank / play.before see of a source: no magnet, path, URL or ref */
function view(s) {
  return {
    id: s.id,
    type: s.type,
    provider: s.provider,
    label: s.label,
    quality: s.quality || null,
    size: s.size == null ? null : Math.round(s.size),
    codec: s.codec || null,
    audio: s.audio || null,
    seeds: s.seeds == null ? null : s.seeds,
    playable: s.playable
  };
}

function nameOf(id) {
  var plugin = plugins.get(id);
  return plugin ? plugin.manifest.name : id;
}

// A magnet's info hash, lowercase hex (base32 ones converted), else null
function hashOf(source) {
  if (source.infoHash) {
    return source.infoHash.toLowerCase();
  }
  var m = /[?&]xt=urn:btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})(?:&|$)/.exec(source.magnet || '');
  if (!m) {
    return null;
  }
  if (m[1].length === 40) {
    return m[1].toLowerCase();
  }
  var bits = '';
  m[1].toUpperCase().split('').forEach(function (c) {
    bits += ('00000' + BASE32.indexOf(c).toString(2)).slice(-5);
  });
  return bits.match(/.{8}/g).map(function (b) { return ('0' + parseInt(b, 2).toString(16)).slice(-2); }).join('');
}

/**
 * A plugin's source as the pipeline's, or null. Magnets keep only their hash
 * and name: the trackers are the server's own (a plugin's tracker list could
 * make the torrent client reach addresses its sandbox may not).
 */
function fromPlugin(plugin, src, context) {
  var play = context.play;
  if (src.kind === 'magnet') {
    var hash = hashOf(src);
    if (!hash) {
      return null;
    }
    var verdict = play.playableByName(src.label + ' ' + (src.fileName || ''), context.ffmpeg);
    return {
      id: 'torrent:' + hash,
      type: 'torrent',
      provider: plugin.id,
      plugin: plugin.id,
      label: src.label,
      infoHash: hash,
      magnet: trackers.build(hash, src.label),
      size: src.size || null,
      quality: src.quality || verdict.description.quality,
      codec: src.codec || verdict.description.codec,
      audio: src.audio || verdict.description.audio,
      seeds: src.seeds == null ? null : src.seeds,
      peers: src.peers == null ? null : src.peers,
      playable: verdict.playable,
      notes: verdict.notes.concat(src.notes || []),
      file: src.fileName || src.fileIndex != null ? { name: src.fileName || null, index: src.fileIndex == null ? null : src.fileIndex } : undefined,
      badges: ['plugin']
    };
  }
  var entry = remote.register(plugin, src),
    named = play.playableByName(entry.name + ' ' + (src.codec || '') + ' ' + (src.audio || ''), context.ffmpeg);
  return {
    id: entry.ref,
    type: 'plugin',
    provider: plugin.id,
    plugin: plugin.id,
    label: src.label,
    ref: entry.ref,
    size: src.size || null,
    quality: src.quality || named.description.quality,
    codec: src.codec || named.description.codec,
    audio: src.audio || named.description.audio,
    playable: named.playable,
    notes: named.notes.concat(src.notes || []),
    badges: ['plugin']
  };
}

/**
 * Every plugin's torrents as one list, as the core ranked its own sites'
 * (lib/episodes.js): one per info hash (the best seeded, every plugin naming
 * it), packs marked, in the streaming order of lib/media/names.js#compare;
 * a plugin reorders them with play.rank. Streams keep their order, first.
 */
function ranked(sources, ref) {
  var streams = [], byHash = {}, torrents = [];
  sources.forEach(function (s) {
    if (s.type !== 'torrent') {
      return streams.push(s);
    }
    var kept = byHash[s.infoHash];
    if (!kept) {
      byHash[s.infoHash] = s;
      return torrents.push(s);
    }
    if ((s.seeds || 0) > (kept.seeds || 0)) {
      torrents[torrents.indexOf(kept)] = s;
      byHash[s.infoHash] = s;
    }
  });
  var keyed = torrents.map(function (s, i) {
    var pack = names.matches(s.label, ref) === 'pack';
    if (pack && s.badges.indexOf('pack') === -1) {
      s.badges = s.badges.concat('pack');
    }
    return { s: s, i: i, key: Object.assign(names.describe(s.label), { seeds: s.seeds || 0, pack: pack }) };
  });
  keyed.sort(function (x, y) {
    return names.compare(x.key, y.key) || x.i - y.i;
  });
  return streams.concat(keyed.map(function (x) { return x.s; }));
}

// The pipeline's collect handler for every plugin with play.collect
var collector = {
  id: 'plugins',
  order: 40,
  timeoutMs: HOOKS['play.collect'].timeoutMs + 1000,
  run: function (title, context) {
    return plugins.runHook('play.collect', { title: titleRef(title) }, context.pluginContext).then(function (r) {
      var sources = [],
        errors = r.errors.map(function (e) {
          return { handler: 'plugin:' + e.plugin, message: e.message };
        });
      r.results.forEach(function (res) {
        var plugin = plugins.get(res.plugin);
        res.output.forEach(function (src) {
          var found = plugin && effects.sourceAllowed(plugin, src) ? fromPlugin(plugin, src, context) : null;
          if (found) {
            found.handler = 'plugin:' + plugin.id;
            sources.push(found);
          } else {
            errors.push({ handler: 'plugin:' + res.plugin, message: 'a source of a kind or host it didn\'t declare: ' + src.label });
          }
        });
      });
      return { sources: ranked(sources, titleRef(title)), errors: errors };
    });
  }
};

/**
 * play.resolve check: marks the torrents a resolver can serve at once
 * (`resolver`, badge `cached`, a note); the first resolver (by id) wins a hash.
 */
function check(sources, context) {
  var torrents = sources.filter(function (s) { return s.type === 'torrent' && s.infoHash; }),
    hashes = [];
  torrents.forEach(function (s) {
    if (hashes.indexOf(s.infoHash) === -1 && hashes.length < 200) {
      hashes.push(s.infoHash);
    }
  });
  if (!hashes.length) {
    return Promise.resolve([]);
  }
  return plugins.runHook('play.resolve', { mode: 'check', hashes: hashes }, context.pluginContext, {
    timeoutMs: HOOKS['play.resolve'].checkTimeoutMs
  }).then(function (r) {
    r.results.forEach(function (res) {
      var answer = res.output.hashes || {},
        plugin = plugins.get(res.plugin);
      if (!plugin || (plugin.permissions.sources || []).indexOf('http') === -1) {
        return;
      }
      torrents.forEach(function (s) {
        var hit = answer[s.infoHash];
        if (hit && hit.cached && !s.resolver) {
          var label = hit.label || plugin.manifest.name;
          s.resolver = { plugin: plugin.id, label: label };
          s.badges = s.badges.concat('cached');
          s.notes = s.notes.concat('Cached on ' + label);
        }
      });
    });
    return r.errors.map(function (e) { return { handler: 'plugin:' + e.plugin, message: 'play.resolve: ' + e.message }; });
  });
}

/**
 * play.rank after the core's ranking: each plugin's answer in turn (by id):
 * hidden sources leave the list (kept in `hidden` with the reason, for the
 * picker), listed ids move first.
 */
function rank(title, sources, context) {
  if (!sources.length) {
    return Promise.resolve({ sources: sources, hidden: [], errors: [] });
  }
  return plugins.runHook('play.rank', { title: titleRef(title), sources: sources.map(view) }, context.pluginContext).then(function (r) {
    var hidden = [];
    r.results.forEach(function (res) {
      var out = res.output, gone = {};
      (out.hide || []).forEach(function (h) {
        gone[h.id] = h.reason;
      });
      sources = sources.filter(function (s) {
        if (gone.hasOwnProperty(s.id)) {
          hidden.push({ id: s.id, label: s.label, plugin: res.plugin, by: nameOf(res.plugin), reason: gone[s.id] });
          return false;
        }
        return true;
      });
      var order = out.order || [],
        first = [];
      order.forEach(function (id) {
        var s = sources.filter(function (x) { return x.id === id; })[0];
        if (s && first.indexOf(s) === -1) {
          first.push(s);
        }
      });
      sources = first.concat(sources.filter(function (s) { return first.indexOf(s) === -1; }));
    });
    return {
      sources: sources,
      hidden: hidden,
      errors: r.errors.map(function (e) { return { handler: 'plugin:' + e.plugin, message: 'play.rank: ' + e.message }; })
    };
  });
}

/**
 * play.before for the chosen source: the first refusal (by plugin id), else
 * the first question unless `confirmed`, else null (go on).
 */
function before(title, source, context, confirmed) {
  return plugins.runHook('play.before', { title: titleRef(title), source: view(source) }, context.pluginContext).then(function (r) {
    var refusal = r.results.filter(function (x) { return x.output.action === 'refuse'; })[0],
      question = r.results.filter(function (x) { return x.output.action === 'ask'; })[0];
    if (refusal) {
      return { action: 'refuse', reason: refusal.output.reason, by: nameOf(refusal.plugin) };
    }
    if (question && !confirmed) {
      return {
        action: 'ask',
        question: question.output.question,
        yes: question.output.yes || 'Play',
        no: question.output.no || 'Cancel',
        by: nameOf(question.plugin)
      };
    }
    return null;
  });
}

/**
 * play.resolve for a cached torrent the user chose: its resolver's http
 * source as a `plugin` source, else (it failed, answered null or a source it
 * may not use) the torrent itself, with a note.
 */
function resolve(title, source, context) {
  var resolver = source.resolver,
    asked = { kind: 'magnet', magnet: source.magnet, infoHash: source.infoHash, label: String(source.label).slice(0, 200) };
  if (source.size) {
    asked.size = Math.round(source.size);
  }
  return plugins.runHook('play.resolve', { mode: 'resolve', title: titleRef(title), source: asked }, context.pluginContext, {
    only: resolver.plugin
  }).then(function (r) {
    var answer = r.results[0] && r.results[0].output.source,
      plugin = plugins.get(resolver.plugin);
    if (answer && plugin && answer.kind === 'http' && effects.sourceAllowed(plugin, answer)) {
      var played = fromPlugin(plugin, answer, context);
      played.provider = source.provider;
      played.handler = 'plugin:' + plugin.id;
      played.infoHash = source.infoHash;
      played.label = source.label;
      played.quality = source.quality || played.quality;
      played.size = played.size || source.size || null;
      played.badges = ['plugin', 'cached'];
      played.notes = ['Through ' + resolver.label].concat(answer.notes || []);
      return played;
    }
    log.warn('play.resolve by ' + resolver.plugin + ' gave nothing for ' + source.infoHash +
      (r.errors[0] ? ': ' + r.errors[0].message : ''));
    return Object.assign({}, source, {
      badges: source.badges.filter(function (b) { return b !== 'cached'; }),
      notes: source.notes.filter(function (n) { return n !== 'Cached on ' + resolver.label; })
        .concat(resolver.label + ' couldn\'t serve it: playing the torrent')
    });
  });
}

/** player.markers: every plugin's markers within the duration, by start */
function markers(title, media, context) {
  var input = { title: titleRef(title), duration: media.duration };
  if (media.fileName) {
    input.fileName = String(media.fileName).slice(0, 500);
  }
  if (media.size) {
    input.size = Math.round(media.size);
  }
  return plugins.runHook('player.markers', input, context.pluginContext).then(function (r) {
    var out = [];
    r.results.forEach(function (res) {
      res.output.forEach(function (m) {
        if (m.start < media.duration && (m.end === undefined || m.end > m.start)) {
          out.push(Object.assign({ plugin: res.plugin }, m, m.end === undefined ? {} : { end: Math.min(m.end, media.duration) }));
        }
      });
    });
    return out.sort(function (a, b) { return a.start - b.start; });
  });
}

/** A request id for start() */
function requestId() {
  return crypto.randomBytes(12).toString('hex');
}

module.exports = {
  register: function (play) {
    play.use(collector);
  },
  titleRef: titleRef,
  check: check,
  rank: rank,
  before: before,
  resolve: resolve,
  markers: markers,
  requestId: requestId,
  // tests
  hashOf: hashOf,
  ranked: ranked,
  collector: collector
};
