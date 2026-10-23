'use strict';

// Notifications (docs/plugins-plan.md §4.10): `playpex.notify.send(profiles,
// { text, tone?, key? })` (permissions.notify) → a short message the clients
// of those profiles show as a toast. Kept LIMITS.notifications.keepMs (24 h)
// for clients that weren't connected, one per plugin and key (the newest
// wins), each shown once per device: a client asks
// `GET /plugins/notifications?profile=` when it opens and on the event
// `plugin.notification { profileId }`, and gets those it hasn't had yet.
// LIMITS.notifications.perHour per plugin and profile (more are refused);
// never to kids profiles for an `adults` plugin. In memory: a restart
// forgets them.

var crypto = require('crypto'),
  protocol = require('@playpex/protocol/plugins'),
  events = require('../events'),
  userData = require('../userData'),
  schemas = require('./schemas');

var LIMITS = protocol.LIMITS.notifications,
  MAX_PER_PROFILE = 50;

var kept = new Map(),    // profile id → [notification]
  sent = new Map();      // plugin id + ' ' + profile id → [times]

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function prune(now) {
  kept.forEach(function (list, profileId) {
    var fresh = list.filter(function (n) { return now - n.at < LIMITS.keepMs; });
    if (fresh.length) {
      kept.set(profileId, fresh);
    } else {
      kept.delete(profileId);
    }
  });
}

function allowed(pluginId, profileId, now) {
  var key = pluginId + ' ' + profileId,
    times = (sent.get(key) || []).filter(function (t) { return now - t < 60 * 60 * 1000; });
  if (times.length >= LIMITS.perHour) {
    sent.set(key, times);
    return false;
  }
  times.push(now);
  sent.set(key, times);
  return true;
}

/**
 * The host's notify.send. profiles: 'all' or profile ids. Answers
 * { sent: [profile ids], limited: [profile ids] } (unknown ids are left out)
 */
function send(plugin, profiles, message) {
  var problem = schemas.apiProblem('notification', message || null);
  if (problem) {
    return Promise.reject(failure('INVALID', 'message: ' + problem));
  }
  if (profiles !== 'all' && !(Array.isArray(profiles) && profiles.length && profiles.every(function (p) { return typeof p === 'string'; }))) {
    return Promise.reject(failure('INVALID', 'profiles must be \'all\' or a list of profile ids'));
  }
  return userData.services().then(function (s) { return s.profiles.list(); }).then(function (all) {
    var now = Date.now(),
      targets = all.filter(function (p) {
        return (profiles === 'all' || profiles.indexOf(p.id) !== -1) &&
          !require('./index').blocked(plugin, { profile: { id: p.id, kids: !!p.isKid } });
      }),
      out = { sent: [], limited: [] };
    prune(now);
    targets.forEach(function (p) {
      if (!allowed(plugin.id, p.id, now)) {
        out.limited.push(p.id);
        return;
      }
      var list = (kept.get(p.id) || []).filter(function (n) {
        return !(message.key && n.plugin === plugin.id && n.key === message.key);
      });
      list.push({
        id: crypto.randomBytes(8).toString('hex'),
        plugin: plugin.id,
        name: plugin.manifest.name,
        text: message.text,
        tone: message.tone || 'info',
        key: message.key || null,
        at: now,
        seenBy: new Set()
      });
      kept.set(p.id, list.slice(-MAX_PER_PROFILE));
      out.sent.push(p.id);
      events.publish('plugin.notification', { profileId: p.id, plugin: plugin.id });
    });
    plugin.stats.notifications = (plugin.stats.notifications || 0) + out.sent.length;
    return out;
  });
}

/** What a device hasn't had yet of a profile's notifications (marked had) */
function take(profileId, deviceId) {
  var now = Date.now();
  prune(now);
  return (kept.get(profileId) || []).filter(function (n) {
    if (n.seenBy.has(deviceId)) {
      return false;
    }
    n.seenBy.add(deviceId);
    return true;
  }).map(function (n) {
    return { id: n.id, plugin: n.plugin, name: n.name, text: n.text, tone: n.tone, key: n.key, at: new Date(n.at).toISOString() };
  });
}

/** A plugin removed: its notifications go */
function forget(pluginId) {
  kept.forEach(function (list, profileId) {
    kept.set(profileId, list.filter(function (n) { return n.plugin !== pluginId; }));
  });
}

module.exports = {
  send: send,
  take: take,
  forget: forget,
  /** tests */
  reset: function () { kept.clear(); sent.clear(); }
};
