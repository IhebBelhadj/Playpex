'use strict';

// Live TV (docs/providers-plan.md §8, step 9): the channels of plugins with
// live.channels, their programmes (live.guide) and a channel's stream when it
// plays (live.stream: IPTV URLs carry tokens that expire, so it is asked then).
//
//   providers(ctx) → [{ plugin, name, guide, channels, updatedAt, error }]
//   channels(pluginId, ctx, { refresh? }) → Promise<{ plugin, name, guide, channels, groups, updatedAt, error }>
//     kept per plugin (6 h; refreshed in the background once older, at once
//     after the admin's Refresh or a settings change), numbered (channels
//     without a number after the highest), one per id; a kids profile gets no
//     `audience: adults` channel. Logos: https ones as they are, http ones and
//     the package's through the server (logo()).
//   guide(pluginId, ids, from, to, ctx) → Promise<{ from, to, programmes }>   ≤ 200 channels, ≤ 48 h; kept 15 min
//   play(pluginId, channelId, ctx) → Promise<{ channel, source }>   source: { kind: 'media', ref, format, label, live }
//   logo(req, res, pluginId, token)   GET /live/{plugin}/logos/{token}: a channel's logo fetched as the plugin
//   status(pluginId) / forget(pluginId)
//
// Hooks run with no profile (the channels are the server's); the plugin's
// audience and hidden rules (lib/plugins#blocked) are applied to the caller.
// Errors: NOT_FOUND (no such live plugin / channel), FORBIDDEN (kids profile,
// adults plugin), PLUGIN_FAILED (it failed and nothing is kept), INVALID.

var crypto = require('crypto'),
  protocol = require('@playpex/protocol/plugins'),
  plugins = require('../plugins'),
  http = require('../plugins/http'),
  effects = require('../plugins/effects'),
  hls = require('../media/hls'),
  grants = require('../plugins/grants'),
  log = require('../logger').child('plugins');

var LIVE = protocol.LIMITS.live,
  CHANNELS_TTL_MS = 6 * 60 * 60 * 1000,
  GUIDE_TTL_MS = 15 * 60 * 1000,
  GUIDE_KEPT = 300,
  LOGO_MAX = 1024 * 1024,
  LOGOS_KEPT = 500,
  LOGO_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml)$/,
  SECRET = crypto.randomBytes(32);

var state = new Map(),    // plugin id → { channels, byId, groups, updatedAt, error, job, durationMs }
  guides = new Map(),     // key → { at, programmes }
  logos = new Map();      // token → { type, body }

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

/** The live plugin, when this caller may use it; throws */
function pluginFor(pluginId, ctx) {
  var plugin = plugins.get(pluginId);
  if (!plugin || plugin.state !== 'enabled' || plugin.registered.hook.indexOf('live.channels') === -1 ||
    (plugin.permissions.hooks || []).indexOf('live.channels') === -1) {
    throw failure('NOT_FOUND', 'No live plugin ' + pluginId);
  }
  if (plugins.blocked(plugin, ctx)) {
    throw failure('FORBIDDEN', 'Not for this profile');
  }
  return plugin;
}

function hasGuide(plugin) {
  return plugin.registered.hook.indexOf('live.guide') !== -1 && (plugin.permissions.hooks || []).indexOf('live.guide') !== -1;
}

function stateOf(id) {
  if (!state.has(id)) {
    state.set(id, { channels: [], byId: new Map(), groups: [], updatedAt: null, error: null, job: null, durationMs: null });
  }
  return state.get(id);
}

// ── logos ──────────────────────────────────────────────────────────────────

function b64(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function logoToken(plugin, url) {
  var payload = b64(Buffer.from(url, 'utf8'));
  return payload + '.' + b64(crypto.createHmac('sha256', SECRET).update(plugin.id + '\n' + url).digest().subarray(0, 16));
}

function logoUrl(plugin, token) {
  var m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
  if (!m) {
    return null;
  }
  var url = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    expected = Buffer.from(b64(crypto.createHmac('sha256', SECRET).update(plugin.id + '\n' + url).digest().subarray(0, 16))),
    given = Buffer.from(m[2]);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? url : null;
}

/** A logo as clients get it: an https URL, else a path under the API prefix (or nothing) */
function presentLogo(plugin, logo) {
  if (!logo) {
    return null;
  }
  if (/^assets\//.test(logo)) {
    return plugin.files.indexOf(logo) !== -1 ? '/plugins/' + plugin.id + '/' + logo : null;
  }
  try {
    http.target(plugin, logo, { stream: true });
  } catch (e) {
    // a host it can't reach: https ones are the client's to load (like a card's image), the rest dropped
    return /^https:\/\//.test(logo) ? logo : null;
  }
  return '/live/' + plugin.id + '/logos/' + logoToken(plugin, logo);
}

function logo(req, res, pluginId, token) {
  var plugin = plugins.get(pluginId),
    url = plugin && plugin.state === 'enabled' ? logoUrl(plugin, token) : null;
  if (!url) {
    return res.status(404).json({ error: 'No such logo', code: 'NOT_FOUND' });
  }
  function send(hit) {
    res.set({
      'Content-Type': hit.type,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=86400',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    });
    res.end(hit.body);
  }
  if (logos.has(token)) {
    return send(logos.get(token));
  }
  http.stream(plugin, { url: url }).then(function (r) {
    var type = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (r.status !== 200 || !LOGO_TYPES.test(type) || parseInt(r.headers['content-length'], 10) > LOGO_MAX) {
      r.abort();
      throw failure('UPSTREAM', r.status !== 200 ? 'HTTP ' + r.status : 'not an image');
    }
    return new Promise(function (ok, fail) {
      var chunks = [], size = 0;
      r.body.on('data', function (c) {
        size += c.length;
        if (size > LOGO_MAX) {
          r.abort();
          return fail(failure('UPSTREAM', 'larger than 1 MB'));
        }
        chunks.push(c);
      });
      r.body.on('end', function () { ok({ type: type, body: Buffer.concat(chunks) }); });
      r.body.on('error', fail);
    });
  }).then(function (hit) {
    logos.set(token, hit);
    while (logos.size > LOGOS_KEPT) {
      logos.delete(logos.keys().next().value);
    }
    send(hit);
  }).catch(function (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'The logo didn\'t load: ' + err.message, code: 'UPSTREAM' });
    }
  });
}

// ── channels ───────────────────────────────────────────────────────────────

/** The plugin's answer as the server keeps it */
function normalized(plugin, list) {
  var seen = new Set(), out = [], highest = 0;
  list.forEach(function (c) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      out.push(Object.assign({}, c));
      highest = Math.max(highest, c.number || 0);
    }
  });
  out.forEach(function (c) {
    if (!c.number) {
      c.number = Math.min(99999, ++highest);
    }
    c.logo = presentLogo(plugin, c.logo);
    if (!c.logo) {
      delete c.logo;
    }
  });
  return out;
}

function groupsOf(channels) {
  var counts = new Map();
  channels.forEach(function (c) {
    if (c.group) {
      counts.set(c.group, (counts.get(c.group) || 0) + 1);
    }
  });
  return Array.from(counts.entries()).map(function (e) { return { name: e[0], count: e[1] }; });
}

/** Asks the plugin for its channels again (one at a time per plugin) */
function load(plugin, refresh) {
  var s = stateOf(plugin.id);
  if (s.job) {
    return s.job;
  }
  var started = Date.now();
  s.job = plugins.runHook('live.channels', refresh ? { refresh: true } : {}, { profile: null, device: null, locale: 'en' }, {
    only: plugin.id
  }).then(function (r) {
    var answer = r.results[0];
    if (!answer) {
      var why = r.errors[0] ? r.errors[0].message : 'no answer';
      s.error = why;
      throw failure('PLUGIN_FAILED', plugin.manifest.name + ' didn\'t list its channels: ' + why);
    }
    var channels = normalized(plugin, answer.output.channels);
    s.channels = channels;
    s.byId = new Map(channels.map(function (c) { return [c.id, c]; }));
    s.groups = groupsOf(channels);
    s.updatedAt = new Date();
    s.error = null;
    s.durationMs = Date.now() - started;
    // a new lineup: older guide windows may name channels that changed
    guides.forEach(function (v, k) {
      if (k.indexOf(plugin.id + ' ') === 0) {
        guides.delete(k);
      }
    });
    log.info('[' + plugin.id + '] ' + channels.length + ' channels in ' + s.durationMs + ' ms', { plugin: plugin.id });
    warm(plugin, channels);
    return s;
  }).finally(function () {
    s.job = null;
  });
  return s.job;
}

function forCaller(ctx) {
  var kids = !!(ctx && ctx.profile && ctx.profile.kids);
  return function (c) { return !(kids && c.audience === 'adults'); };
}

function channels(pluginId, ctx, options) {
  var plugin;
  try {
    plugin = pluginFor(pluginId, ctx);
  } catch (err) {
    return Promise.reject(err);
  }
  var s = stateOf(plugin.id),
    stale = !s.updatedAt || Date.now() - s.updatedAt.getTime() > CHANNELS_TTL_MS,
    wait = !s.updatedAt || (options && options.refresh);
  var ready = wait ? load(plugin, options && options.refresh) : Promise.resolve(s);
  if (!wait && stale) {
    load(plugin, false).catch(function () { /* kept: the last good list */ });
  }
  return ready.then(function () {
    var list = s.channels.filter(forCaller(ctx));
    return {
      plugin: plugin.id,
      name: plugin.manifest.name,
      guide: hasGuide(plugin),
      channels: list,
      groups: list.length === s.channels.length ? s.groups : groupsOf(list),
      updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
      error: s.error
    };
  });
}

function providers(ctx) {
  return plugins.withHook('live.channels', ctx).filter(function (p) {
    return plugins.withHook('live.stream', ctx).some(function (x) { return x.id === p.id; });
  }).map(function (p) {
    var s = state.get(p.id), plugin = plugins.get(p.id);
    return {
      plugin: p.id,
      name: p.name,
      guide: hasGuide(plugin),
      channels: s && s.updatedAt ? s.channels.filter(forCaller(ctx)).length : null,
      updatedAt: s && s.updatedAt ? s.updatedAt.toISOString() : null,
      error: s ? s.error : null
    };
  });
}

// ── guide ──────────────────────────────────────────────────────────────────

function guide(pluginId, ids, from, to, ctx) {
  var plugin;
  try {
    plugin = pluginFor(pluginId, ctx);
  } catch (err) {
    return Promise.reject(err);
  }
  var start = Date.parse(from), end = Date.parse(to);
  if (!Array.isArray(ids) || !ids.length || ids.length > LIVE.guideChannels) {
    return Promise.reject(failure('INVALID', 'channels: 1 to ' + LIVE.guideChannels + ' channel ids'));
  }
  if (!isFinite(start) || !isFinite(end) || end <= start || end - start > LIVE.guideHours * 3600000) {
    return Promise.reject(failure('INVALID', 'from / to: dates, at most ' + LIVE.guideHours + ' h apart'));
  }
  var window = { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
  if (!hasGuide(plugin)) {
    return Promise.resolve(Object.assign(window, { programmes: [] }));
  }
  var wanted = ids.slice().sort(),
    key = plugin.id + ' ' + window.from + ' ' + window.to + ' ' + wanted.join(','),
    hit = guides.get(key);
  if (hit && Date.now() - hit.at < GUIDE_TTL_MS) {
    return Promise.resolve(Object.assign(window, { programmes: hit.programmes }));
  }
  return plugins.runHook('live.guide', { channels: wanted, from: window.from, to: window.to }, { profile: null, device: null, locale: ctx && ctx.locale || 'en' }, {
    only: plugin.id
  }).then(function (r) {
    var answer = r.results[0];
    if (!answer) {
      throw failure('PLUGIN_FAILED', plugin.manifest.name + '\'s guide didn\'t answer' + (r.errors[0] ? ': ' + r.errors[0].message : ''));
    }
    var asked = new Set(wanted),
      programmes = answer.output.programmes.filter(function (p) {
        var a = Date.parse(p.start), b = Date.parse(p.end);
        return asked.has(p.channel) && isFinite(a) && isFinite(b) && b > a && b > start && a < end;
      }).sort(function (a, b) {
        return a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : Date.parse(a.start) - Date.parse(b.start);
      });
    guides.set(key, { at: Date.now(), programmes: programmes });
    while (guides.size > GUIDE_KEPT) {
      guides.delete(guides.keys().next().value);
    }
    return Object.assign(window, { programmes: programmes });
  });
}

// The first guide window of the first channels, asked in the background: a
// big guide is downloaded and parsed before anyone opens it
function warm(plugin, channels) {
  if (!hasGuide(plugin) || !channels.length) {
    return;
  }
  var from = Math.floor(Date.now() / 1800000) * 1800000;
  guide(plugin.id, channels.slice(0, 50).map(function (c) { return c.id; }), new Date(from).toISOString(),
    new Date(from + 3 * 3600000).toISOString(), { profile: null, locale: 'en' }).catch(function (err) {
    log.debug('[' + plugin.id + '] guide not warmed: ' + err.message, { plugin: plugin.id });
  });
}

// ── playing a channel ──────────────────────────────────────────────────────

function play(pluginId, channelId, ctx) {
  var plugin;
  try {
    plugin = pluginFor(pluginId, ctx);
  } catch (err) {
    return Promise.reject(err);
  }
  return channels(pluginId, ctx).then(function () {
    var channel = stateOf(plugin.id).byId.get(channelId);
    if (!channel || !forCaller(ctx)(channel)) {
      throw failure('NOT_FOUND', 'No channel ' + channelId);
    }
    // the plugin gets the channel as it listed it (its own logo, not ours)
    var asked = Object.assign({}, channel);
    delete asked.logo;
    return plugins.runHook('live.stream', { channel: asked }, ctx, { only: plugin.id }).then(function (r) {
      var source = r.results[0] && r.results[0].output.source;
      if (!source) {
        throw failure('PLUGIN_FAILED', channel.name + ' can\'t play now' + (r.errors[0] ? ': ' + r.errors[0].message : ''));
      }
      if ((source.kind !== 'hls' && source.kind !== 'live') || !effects.sourceAllowed(plugin, source)) {
        throw failure('PLUGIN_FAILED', plugin.manifest.name + ' answered a stream it may not play (' + source.kind + ')');
      }
      // from the admin's own address: its parts may come from any public host (lib/media/hls.js)
      var open = !!grants.match(plugin, source.url, { stream: true }),
        entry = hls.register(plugin, Object.assign({}, source, { label: source.label || channel.name }), { open: open });
      return {
        channel: channel,
        source: { kind: 'media', ref: entry.ref, format: entry.format, label: channel.name, live: true }
      };
    });
  });
}

// ── admin ──────────────────────────────────────────────────────────────────

function status(pluginId) {
  var s = state.get(pluginId);
  return {
    channels: s ? s.channels.length : null,
    groups: s ? s.groups : [],
    updatedAt: s && s.updatedAt ? s.updatedAt.toISOString() : null,
    durationMs: s ? s.durationMs : null,
    error: s ? s.error : null,
    refreshing: !!(s && s.job)
  };
}

/** Forgets what a plugin listed (unloaded, its settings changed): asked again on the next use */
function forget(pluginId) {
  state.delete(pluginId);
  guides.forEach(function (v, k) {
    if (k.indexOf(pluginId + ' ') === 0) {
      guides.delete(k);
    }
  });
}

module.exports = {
  providers: providers,
  channels: channels,
  guide: guide,
  play: play,
  logo: logo,
  status: status,
  forget: forget,
  reset: function () {
    state.clear();
    guides.clear();
    logos.clear();
  }
};
