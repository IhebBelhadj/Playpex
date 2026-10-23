'use strict';

// Account linking (docs/plugins-plan.md §4.8), run from the dashboard (Plugins
// › <name> › Accounts; never on a client). A manifest's `link` entries:
//
//   deviceCode   an RFC 8628 device flow the host runs: "Link" asks codeUrl for
//                a code (client id from the plugin's secret `clientIdSecret`),
//                the dashboard shows it with its URL, the host polls tokenUrl
//                (at the interval it says, slowing down when told) until the
//                person entered it, then keeps the tokens with the plugin's
//                secrets (`link:<name>`, per profile for scope profile) and
//                refreshes them when they near expiry. Requests go out as the
//                plugin (its hosts, the address rules); `body: 'json'` for
//                services that don't take forms (Trakt), and both `device_code`
//                and `code` are sent to the token URL.
//   custom       a data handler of the plugin answering a code to show and a
//                poll handler (asked every 5 s by the dashboard), or a form to
//                fill and a submit handler; `done` marks the account linked.
//
// The plugin reads a link with `playpex.link.status(name, profileId)` →
// { linked, accessToken, expiresAt } (needs the link in permissions.link).

var protocol = require('@playpex/protocol/plugins'),
  plugins = require('./index'),
  http = require('./http'),
  schemas = require('./schemas'),
  userData = require('../userData'),
  log = require('../logger').child('plugins');

var GRANT = 'urn:ietf:params:oauth:grant-type:device_code',
  REFRESH_BEFORE_MS = 5 * 60 * 1000,
  CUSTOM_POLL_MS = 5000;

var pending = new Map();   // '<plugin> <link> <profile>' → { state, message, … }

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function services() {
  return userData.services();
}

function keyOf(pluginId, name, profileId) {
  return pluginId + ' ' + name + ' ' + (profileId || '');
}

function secretName(name) {
  return 'link:' + name;
}

/** The loaded, enabled plugin and its link `name` */
function linkOf(pluginId, name) {
  var plugin = plugins.get(pluginId);
  if (!plugin) {
    throw failure('NOT_FOUND', 'No plugin ' + pluginId);
  }
  var link = (plugin.manifest.link || []).filter(function (l) { return l.name === name; })[0];
  if (!link) {
    throw failure('NOT_FOUND', 'No link ' + name);
  }
  if (plugin.state !== 'enabled') {
    throw failure('CONFLICT', 'Switch the plugin on first');
  }
  return { plugin: plugin, link: link };
}

/** The profile a link is for: { id, kids } for scope profile, null for scope server */
function profileFor(plugin, link, profileId) {
  if (link.scope === 'server') {
    return Promise.resolve(null);
  }
  if (!profileId) {
    return Promise.reject(failure('INVALID', link.label + ' is linked per profile: name the profile'));
  }
  return services().then(function (s) { return s.profiles.get(profileId); }).then(function (p) {
    if (p.isKid && plugin.manifest.audience === 'adults') {
      throw failure('FORBIDDEN', 'not for kids profiles');
    }
    return { id: p.id, kids: !!p.isKid };
  }, function () {
    throw failure('NOT_FOUND', 'No profile ' + profileId);
  });
}

function readTokens(pluginId, name, profileId) {
  return services().then(function (s) { return s.plugins.secrets.get(pluginId, secretName(name), profileId || ''); }).then(function (text) {
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  });
}

function writeTokens(pluginId, name, profileId, tokens) {
  return services().then(function (s) {
    return s.plugins.secrets.set(pluginId, secretName(name), tokens ? JSON.stringify(tokens) : null, profileId || '');
  });
}

function secretOf(pluginId, name) {
  return name ? services().then(function (s) { return s.plugins.secrets.get(pluginId, name, ''); }) : Promise.resolve(null);
}

// ── device code ─────────────────────────────────────────────────────────────

// One POST as the plugin, the answer's JSON (null when it isn't)
function post(plugin, flow, url, fields) {
  var json = flow.body === 'json',
    body = json ? fields : Object.keys(fields).filter(function (k) { return fields[k] != null; }).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(fields[k]);
    }).join('&');
  return http.request(plugin, {
    url: url,
    method: 'POST',
    headers: Object.assign({ Accept: 'application/json' }, json ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: body,
    responseType: 'text'
  }).then(function (r) {
    var parsed = null;
    try {
      parsed = r.value.body ? JSON.parse(r.value.body) : null;
    } catch (e) { /* not JSON */ }
    return { status: r.value.status, body: parsed };
  });
}

function tokensFrom(body) {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    tokenType: body.token_type || 'Bearer',
    scope: body.scope || null,
    expiresAt: body.expires_in ? new Date(Date.now() + Number(body.expires_in) * 1000).toISOString() : null,
    linkedAt: new Date().toISOString()
  };
}

// What a token answer means: done (tokens), pending, slow_down, or failed (why)
function tokenOutcome(r) {
  if (r.status >= 200 && r.status < 300 && r.body && r.body.access_token) {
    return { state: 'done' };
  }
  var error = r.body && r.body.error;
  if (error === 'authorization_pending' || (!error && r.status === 400)) {
    return { state: 'pending' };
  }
  if (error === 'slow_down' || r.status === 429) {
    return { state: 'slow_down' };
  }
  if (error === 'access_denied' || r.status === 418) {
    return { state: 'failed', message: 'The code was refused' };
  }
  if (error === 'expired_token' || r.status === 410) {
    return { state: 'failed', message: 'The code expired' };
  }
  return { state: 'failed', message: 'The service answered ' + (error || 'HTTP ' + r.status) };
}

function startDeviceCode(plugin, link, profile) {
  var flow = link.deviceCode, key = keyOf(plugin.id, link.name, profile && profile.id);
  return Promise.all([secretOf(plugin.id, flow.clientIdSecret), secretOf(plugin.id, flow.clientSecretSecret)]).then(function (ids) {
    if (!ids[0]) {
      throw failure('INVALID', 'Enter its ' + flow.clientIdSecret + ' in Settings first');
    }
    return post(plugin, flow, flow.codeUrl, { client_id: ids[0], scope: flow.scope || null }).then(function (r) {
      var b = r.body || {},
        url = b.verification_uri || b.verification_url;
      if (r.status >= 300 || !b.device_code || !b.user_code || !url) {
        throw failure('UPSTREAM', link.label + ' didn\'t give a code (HTTP ' + r.status + ')');
      }
      var old = pending.get(key);
      if (old) {
        clearTimeout(old.timer);
      }
      var job = {
        state: 'pending', message: null,
        code: b.user_code, url: url, urlComplete: b.verification_uri_complete || null,
        expiresAt: Date.now() + (Number(b.expires_in) || 600) * 1000,
        intervalMs: Math.max(1, Number(b.interval) || 5) * 1000,
        timer: null
      };
      pending.set(key, job);
      function poll() {
        if (pending.get(key) !== job) {
          return;
        }
        if (Date.now() > job.expiresAt) {
          job.state = 'failed';
          job.message = 'The code expired';
          return;
        }
        post(plugin, flow, flow.tokenUrl, {
          grant_type: GRANT, device_code: b.device_code, code: b.device_code, client_id: ids[0], client_secret: ids[1] || null
        }).then(function (t) {
          var outcome = tokenOutcome(t);
          if (outcome.state === 'done') {
            return writeTokens(plugin.id, link.name, profile && profile.id, tokensFrom(t.body)).then(function () {
              job.state = 'done';
              log.info('plugin ' + plugin.id + ' linked ' + link.name + (profile ? ' for a profile' : ''), { plugin: plugin.id });
              plugins.publish({ id: plugin.id, state: plugin.state, reason: 'link' });
            });
          }
          if (outcome.state === 'failed') {
            job.state = 'failed';
            job.message = outcome.message;
            return;
          }
          if (outcome.state === 'slow_down') {
            job.intervalMs += 5000;
          }
          job.timer = setTimeout(poll, job.intervalMs);
        }, function (err) {
          // the network: try again at the next interval, until the code expires
          job.message = err.message;
          job.timer = setTimeout(poll, job.intervalMs);
        });
      }
      job.timer = setTimeout(poll, job.intervalMs);
      return { kind: 'code', code: job.code, url: job.url, urlComplete: job.urlComplete, expiresAt: new Date(job.expiresAt).toISOString() };
    });
  });
}

/** Fresh tokens for a link, refreshed when they're about to expire */
function fresh(plugin, link, profileId) {
  return readTokens(plugin.id, link.name, profileId).then(function (tokens) {
    if (!tokens || !link.deviceCode || !tokens.refreshToken || !tokens.expiresAt ||
      Date.parse(tokens.expiresAt) - Date.now() > REFRESH_BEFORE_MS) {
      return tokens;
    }
    var flow = link.deviceCode;
    return Promise.all([secretOf(plugin.id, flow.clientIdSecret), secretOf(plugin.id, flow.clientSecretSecret)]).then(function (ids) {
      return post(plugin, flow, flow.refreshUrl || flow.tokenUrl, {
        grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: ids[0], client_secret: ids[1] || null
      });
    }).then(function (r) {
      if (r.status >= 300 || !r.body || !r.body.access_token) {
        log.warn('plugin ' + plugin.id + ': refreshing ' + link.name + ' failed (HTTP ' + r.status + ')', { plugin: plugin.id });
        return tokens;
      }
      var next = Object.assign(tokensFrom(r.body), { linkedAt: tokens.linkedAt });
      next.refreshToken = next.refreshToken || tokens.refreshToken;
      return writeTokens(plugin.id, link.name, profileId, next).then(function () { return next; });
    }, function (err) {
      log.warn('plugin ' + plugin.id + ': refreshing ' + link.name + ' failed: ' + err.message, { plugin: plugin.id });
      return tokens;
    });
  });
}

// ── custom ──────────────────────────────────────────────────────────────────

function contextOf(profile) {
  return { profile: profile, device: null, locale: 'en' };
}

function startCustom(plugin, link, profile) {
  var key = keyOf(plugin.id, link.name, profile && profile.id);
  return plugins.data(plugin.id, link.custom, { link: link.name }, contextOf(profile)).then(function (answer) {
    var problem = schemas.apiProblem('linkStart', answer.data || null);
    if (problem) {
      throw failure('PLUGIN_FAILED', 'its link answer: ' + problem);
    }
    var d = answer.data;
    pending.set(key, { state: 'pending', message: null, poll: d.poll || null, submit: d.submit || null, lastPoll: 0,
      expiresAt: Date.now() + (d.expiresIn || 900) * 1000 });
    return d.form
      ? { kind: 'form', form: d.form, help: d.help || null }
      : { kind: 'code', code: d.code, url: d.url, urlComplete: null, qr: !!d.qr,
        expiresAt: new Date(Date.now() + (d.expiresIn || 900) * 1000).toISOString() };
  });
}

function finishCustom(plugin, link, profile, job, handler, args) {
  return plugins.data(plugin.id, handler, Object.assign({ link: link.name }, args || {}), contextOf(profile)).then(function (answer) {
    var problem = schemas.apiProblem('linkPoll', answer.data || null);
    if (problem) {
      throw failure('PLUGIN_FAILED', 'its link answer: ' + problem);
    }
    job.state = answer.data.state;
    job.message = answer.data.message || null;
    if (job.state !== 'done') {
      return;
    }
    return writeTokens(plugin.id, link.name, profile && profile.id, { linkedAt: new Date().toISOString(), custom: true }).then(function () {
      plugins.publish({ id: plugin.id, state: plugin.state, reason: 'link' });
    });
  });
}

// ── the dashboard's calls ───────────────────────────────────────────────────

/** "Link": { kind: 'code', code, url, urlComplete, expiresAt } or { kind: 'form', form, help } */
function start(pluginId, name, profileId) {
  return Promise.resolve().then(function () {
    var found = linkOf(pluginId, name);
    return profileFor(found.plugin, found.link, profileId).then(function (profile) {
      return found.link.deviceCode
        ? startDeviceCode(found.plugin, found.link, profile)
        : startCustom(found.plugin, found.link, profile);
    });
  });
}

/** How a started link is going: { state: pending | done | failed | none, message } */
function progress(pluginId, name, profileId) {
  return Promise.resolve().then(function () {
    var found = linkOf(pluginId, name),
      job = pending.get(keyOf(pluginId, name, profileId));
    if (!job) {
      return { state: 'none', message: null };
    }
    if (job.state === 'pending' && job.poll && Date.now() - job.lastPoll >= CUSTOM_POLL_MS - 500) {
      job.lastPoll = Date.now();
      return profileFor(found.plugin, found.link, profileId).then(function (profile) {
        return finishCustom(found.plugin, found.link, profile, job, job.poll);
      }).then(function () {
        return { state: job.state, message: job.message };
      });
    }
    return { state: job.state, message: job.message };
  });
}

/** A custom link's form, filled: { state, message } */
function submit(pluginId, name, profileId, values) {
  return Promise.resolve().then(function () {
    var found = linkOf(pluginId, name),
      job = pending.get(keyOf(pluginId, name, profileId));
    if (!job || !job.submit) {
      throw failure('CONFLICT', 'Start linking first');
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw failure('INVALID', 'values must be an object');
    }
    return profileFor(found.plugin, found.link, profileId).then(function (profile) {
      return finishCustom(found.plugin, found.link, profile, job, job.submit, { values: values });
    }).then(function () {
      return { state: job.state, message: job.message };
    });
  });
}

function unlink(pluginId, name, profileId) {
  return Promise.resolve().then(function () {
    var plugin = plugins.get(pluginId);
    if (!plugin || !(plugin.manifest.link || []).some(function (l) { return l.name === name; })) {
      throw failure('NOT_FOUND', 'No link ' + name);
    }
    var job = pending.get(keyOf(pluginId, name, profileId));
    if (job) {
      clearTimeout(job.timer);
      pending.delete(keyOf(pluginId, name, profileId));
    }
    return writeTokens(pluginId, name, profileId, null).then(function () {
      plugins.publish({ id: plugin.id, state: plugin.state, reason: 'link' });
      return { ok: true };
    });
  });
}

/** The dashboard's Accounts: each link, and its accounts (one per profile, or the server's) */
function list(pluginId) {
  var plugin = plugins.get(pluginId);
  if (!plugin) {
    return Promise.reject(failure('NOT_FOUND', 'No plugin ' + pluginId));
  }
  var links = plugin.manifest.link || [];
  return services().then(function (s) { return s.profiles.list(); }).then(function (profiles) {
    profiles = profiles.filter(function (p) { return !(p.isKid && plugin.manifest.audience === 'adults'); });
    return Promise.all(links.map(function (link) {
      var owners = link.scope === 'server' ? [null] : profiles;
      return Promise.all(owners.map(function (p) {
        var profileId = p ? p.id : null;
        return readTokens(plugin.id, link.name, profileId).then(function (tokens) {
          var job = pending.get(keyOf(plugin.id, link.name, profileId));
          return {
            profileId: profileId,
            profileName: p ? p.name : null,
            linked: !!tokens,
            linkedAt: tokens ? tokens.linkedAt || null : null,
            expiresAt: tokens ? tokens.expiresAt || null : null,
            pending: !!(job && job.state === 'pending')
          };
        });
      })).then(function (accounts) {
        return {
          name: link.name,
          label: plugins.localize(plugin, link.label, 'en'),
          scope: link.scope,
          kind: link.deviceCode ? 'deviceCode' : 'custom',
          accounts: accounts
        };
      });
    }));
  });
}

/** The host's link.status(name, profileId) → { linked, accessToken, expiresAt } */
function status(plugin, name, profileId) {
  if ((plugin.permissions.link || []).indexOf(name) === -1) {
    return Promise.reject(failure('PERMISSION_DENIED', 'link ' + name + ' isn\'t in permissions.link'));
  }
  var link = (plugin.manifest.link || []).filter(function (l) { return l.name === name; })[0];
  if (!link) {
    return Promise.reject(failure('INVALID', 'no link ' + name));
  }
  if (link.scope === 'profile' && !profileId) {
    return Promise.reject(failure('INVALID', name + ' is linked per profile: pass the profile id'));
  }
  return fresh(plugin, link, link.scope === 'profile' ? profileId : null).then(function (tokens) {
    return {
      linked: !!tokens,
      accessToken: tokens && tokens.accessToken ? tokens.accessToken : null,
      expiresAt: tokens ? tokens.expiresAt || null : null
    };
  });
}

/** A plugin unloaded: its links in progress stop */
function forget(pluginId) {
  pending.forEach(function (job, key) {
    if (key.indexOf(pluginId + ' ') === 0) {
      clearTimeout(job.timer);
      pending.delete(key);
    }
  });
}

module.exports = {
  start: start,
  progress: progress,
  submit: submit,
  unlink: unlink,
  list: list,
  status: status,
  forget: forget,
  LINK_SECRET: secretName,
  PERSONAL: protocol.PERSONAL
};
