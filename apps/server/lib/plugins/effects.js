'use strict';

// What a plugin's data answer may ask a client to do (docs/plugins-plan.md
// §5.3), checked against its permissions before the answer leaves the server:
//   play      needs permissions.play; each source a kind of permissions.sources
//             (an http source on a declared host); audience adults → tracking 'none';
//             an http source leaves as { kind: 'media', ref: 'r_…', label, … }:
//             the server proxies it (./remote.js), the client never sees its URL
//   download  needs write: ['downloads'], the same source rules; torrents only
//   open      its own screens (plugin.<id>.*) or core.movie / show / episode / search
//   confirm   its `then` checked the same way
// An effect that breaks a rule is dropped (and logged), the rest of the answer stays.

var protocol = require('@playpex/protocol/plugins'),
  remote = require('./remote');

// An http source as clients get it: a media ref, never the URL or its headers
function forClient(plugin, source) {
  if (source.kind !== 'http') {
    return source;
  }
  var entry = remote.register(plugin, source),
    out = { kind: 'media', ref: entry.ref, label: source.label };
  ['quality', 'size', 'codec', 'audio', 'notes'].forEach(function (k) {
    if (source[k] !== undefined) {
      out[k] = source[k];
    }
  });
  return out;
}

function sourceAllowed(plugin, source) {
  var p = plugin.manifest.permissions;
  if ((p.sources || []).indexOf(source.kind) === -1) {
    return false;
  }
  if (source.kind === 'http') {
    try {
      return protocol.hostAllowed(p.network, new URL(source.url).hostname);
    } catch (e) {
      return false;
    }
  }
  return true;
}

function intentAllowed(plugin, intent) {
  var own = 'plugin.' + plugin.id + '.';
  return intent.screen.indexOf(own) === 0 || /^core\.(movie|show|episode|search)$/.test(intent.screen);
}

/** The effect, possibly adjusted, or null when it isn't allowed; why in `dropped` */
function check(plugin, effect, dropped) {
  var p = plugin.manifest.permissions,
    adults = plugin.manifest.audience === 'adults';
  switch (effect.type) {
    case 'play':
      if (!p.play) {
        dropped.push('play needs permissions.play');
        return null;
      }
      if (!effect.request.sources.every(function (s) { return sourceAllowed(plugin, s); })) {
        dropped.push('play: a source of a kind or host it didn\'t declare');
        return null;
      }
      effect = JSON.parse(JSON.stringify(effect));
      effect.request.sources = effect.request.sources.map(function (src) { return forClient(plugin, src); });
      if (adults) {
        effect.request.tracking = 'none';
      }
      return effect;
    case 'download':
      if ((p.write || []).indexOf('downloads') === -1) {
        dropped.push('download needs write: downloads');
        return null;
      }
      if (!sourceAllowed(plugin, effect.request.source)) {
        dropped.push('download: a source of a kind or host it didn\'t declare');
        return null;
      }
      if (effect.request.source.kind !== 'magnet') {
        dropped.push('download: only torrents (magnet sources) can be downloaded');
        return null;
      }
      return effect;
    case 'open':
      if (!intentAllowed(plugin, effect.intent)) {
        dropped.push('open: ' + effect.intent.screen + ' isn\'t its screen');
        return null;
      }
      return effect;
    case 'confirm':
      if (effect.then.type === 'call') {
        return effect;
      }
      var then = check(plugin, effect.then, dropped);
      return then ? Object.assign({}, effect, { then: then }) : null;
    default:
      return effect;
  }
}

/** { effects, dropped: [why] } */
function filter(plugin, effects) {
  var dropped = [];
  var kept = (effects || []).map(function (e) { return check(plugin, e, dropped); }).filter(Boolean);
  return { effects: kept, dropped: dropped };
}

module.exports = {
  filter: filter,
  sourceAllowed: sourceAllowed,
  intentAllowed: intentAllowed
};
