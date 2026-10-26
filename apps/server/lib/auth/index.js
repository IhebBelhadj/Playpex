'use strict';

// Auth (docs/server-separation-plan.md §6.3), on Better Auth (decision I).
//
// One user: the server's admin ("owner"), made on first use without a
// password; the first-run setup (POST /admin/setup, or
// `playpex-server admin set <username>`) gives it a username and password.
// Devices pair with the RFC 8628 device flow (Better Auth's
// device-authorization plugin): the client asks for a code, shows it, polls;
// the admin approves it (dashboard, tray, CLI). The token the client gets is
// a Better Auth session of the owner, with a row in `devices` (made in the
// same request, databaseHooks below), which is what makes it a device.
//
// Callers (identify(req) → req.auth):
//   { kind: 'device', device }  Authorization: Bearer <token>, or ?access_token= (media elements)
//   { kind: 'admin', session }  Better Auth's signed session cookie (the dashboard), not a device's
//   { kind: 'local' }           loopback, unless security.requirePairingOnLoopback
//   { kind: 'internal' }        ffmpeg / ffprobe reading a file through our own routes (internalUrlToken)
//   null                        → 401 PAIRING_REQUIRED on client routes
//
// Better Auth is ESM-only; Node ≥ 22.12 (Electron 44 = Node 24) require()s it.
// It is loaded on first use (~300 ms), not when the server is required.

var crypto = require('crypto'),
  fs = require('fs'),
  path = require('path'),
  net = require('net'),
  orm = require('drizzle-orm'),
  protocol = require('@playpex/protocol'),
  paths = require('../paths'),
  settings = require('../settings'),
  userData = require('../userData'),
  events = require('../events'),
  schema = require('../db/schema'),
  log = require('../logger').child('auth');

var SECRET_FILE = path.join(paths.config, 'auth.json');

var OWNER_EMAIL = 'admin@playpex.local',
  // Device sessions: a year, renewed (sliding) at most once a day while used
  SESSION_DAYS = 365,
  UPDATE_AGE_S = 24 * 3600,
  // The admin's cookie session is refused (and deleted) after this, however active
  ADMIN_SESSION_DAYS = 30,
  LAST_SEEN_EVERY_MS = 60 * 1000,
  POLL_INTERVAL = '5s';

// The header our middleware fills with the socket's address for Better Auth
// (rate limits, session ipAddress). Any incoming copy is overwritten: clients
// can't choose their address.
var ADDRESS_HEADER = 'x-playpex-remote-address';

// client_id of the device flow: names the app ('playpex-tv', …). Public
// clients, so not a secret; only its shape is checked.
var CLIENT_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;

// Better Auth endpoints reachable over HTTP (under /api/v1/auth); every other
// one answers 404. Device tokens authenticate none of them (no bearer plugin):
// they only work on our own routes, through identify().
var EXPOSED = {
  'POST /device/code': true,
  'POST /device/token': true,
  'POST /sign-in/username': true,
  'POST /sign-out': true,
  'GET /get-session': true
};

var state = null,          // Promise<{ auth, ctx, db, ownerId }>
  internalToken = crypto.randomBytes(24).toString('hex');

// ── setup ──────────────────────────────────────────────────────────────────

function readSecret() {
  try {
    var data = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    if (typeof data.secret === 'string' && data.secret.length >= 32) {
      return data.secret;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log.warn('auth.json unreadable, making a new secret (admin and devices must sign in / pair again)', { err: e });
    }
  }
  var secret = crypto.randomBytes(32).toString('base64');
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  fs.writeFileSync(SECRET_FILE, JSON.stringify({ secret: secret }, null, 2) + '\n', { mode: 384 });   // 0600
  return secret;
}

function remoteAddress(req) {
  return String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function isLoopback(req) {
  var a = remoteAddress(req);
  return a === '::1' || (net.isIPv4(a) && a.indexOf('127.') === 0);
}

function betterAuthLogger() {
  return {
    log: function (level, message) {
      var fn = log[level === 'success' ? 'info' : level] || log.info;
      fn('better-auth: ' + message);
    }
  };
}

// Rows of `devices` are made with the session the device flow creates
function deviceSessionCreated(db, session, ctx) {
  if (!ctx || ctx.path !== '/device/token') {
    return Promise.resolve();
  }
  var headers = ctx.request ? ctx.request.headers : ctx.headers,
    client = protocol.parseClientHeader(headers && headers.get(protocol.CLIENT_HEADER)),
    now = new Date(),
    row = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      clientId: String(ctx.body && ctx.body.client_id || ''),
      client: client && client.name ? client.name + (client.version ? '/' + client.version : '') : null,
      address: headers ? headers.get(ADDRESS_HEADER) : null,
      createdAt: now,
      lastSeenAt: now
    };
  return db.insert(schema.devices).values(row).then(function () {
    log.info('device paired: ' + row.id + ' (' + row.clientId + ')', { address: row.address });
    events.publish('device.paired', { id: row.id, clientId: row.clientId, address: row.address }, { admin: true });
  });
}

// The address a client shows for typing on a phone: the server's .local name
// (lib/discovery.js) rather than the IP the client reached it by. The complete
// link (the QR code, never typed) keeps the address that worked for the client.
function namedLink(code) {
  var host = require('../discovery').hostName();
  if (!host || typeof code.verification_uri !== 'string') {
    return;
  }
  try {
    var url = new URL(code.verification_uri);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
      url.hostname = host;
      code.verification_uri = url.toString();
    }
  } catch (e) { /* not an absolute URL: left as it is */ }
}

function create(db) {
  var betterAuth = require('better-auth/minimal').betterAuth,
    drizzleAdapter = require('better-auth/adapters/drizzle').drizzleAdapter,
    username = require('better-auth/plugins/username').username,
    deviceAuthorization = require('better-auth/plugins/device-authorization').deviceAuthorization,
    minutes = settings.get('security.pairingRequestMinutes');

  return betterAuth({
    appName: 'Playpex Media Server',
    basePath: protocol.API_PREFIX + '/auth',
    // Reached by many names (localhost, LAN addresses, <host>.local): the
    // base URL follows the request; lib/middleware.js#hostCheck already
    // refused unknown Host headers.
    baseURL: { allowedHosts: ['*'], protocol: 'http' },
    secret: readSecret(),
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        authUser: schema.authUser,
        authSession: schema.authSession,
        authAccount: schema.authAccount,
        authVerification: schema.authVerification,
        authDeviceCode: schema.authDeviceCode
      }
    }),
    user: { modelName: 'authUser' },
    account: { modelName: 'authAccount' },
    verification: { modelName: 'authVerification' },
    session: {
      modelName: 'authSession',
      expiresIn: SESSION_DAYS * 24 * 3600,
      updateAge: UPDATE_AGE_S
    },
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 8 },
    plugins: [
      username(),
      deviceAuthorization({
        expiresIn: minutes + 'm',
        interval: POLL_INTERVAL,
        // The dashboard's page where the admin types the code (plan §7, step 5)
        verificationUri: '/link',
        validateClient: function (clientId) { return CLIENT_ID.test(clientId); },
        schema: { deviceCode: { modelName: 'authDeviceCode' } }
      })
    ],
    hooks: {
      after: require('better-auth/api').createAuthMiddleware(function (ctx) {
        var returned = ctx.context.returned;
        if (ctx.path === '/device/code' && returned && typeof returned.user_code === 'string') {
          namedLink(returned);
          return noteRequest(db, returned.user_code, ctx.request ? ctx.request.headers : ctx.headers);
        }
        return Promise.resolve();
      })
    },
    databaseHooks: {
      session: {
        create: {
          after: function (session, ctx) { return deviceSessionCreated(db, session, ctx); }
        }
      }
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/username': { window: 60, max: 5 },
        '/device/code': { window: 60, max: 10 },
        '/device/token': { window: 60, max: 60 }
      }
    },
    advanced: {
      ipAddress: { ipAddressHeaders: [ADDRESS_HEADER] },
      useSecureCookies: false,
      cookiePrefix: 'playpex'
    },
    telemetry: { enabled: false },
    logger: betterAuthLogger()
  });
}

// The owner (admin) user, made once
function ensureOwner(ctx, db) {
  return db.select({ id: schema.authUser.id }).from(schema.authUser).limit(1).then(function (rows) {
    if (rows.length) {
      return rows[0].id;
    }
    return ctx.internalAdapter.createUser({ name: 'Admin', email: OWNER_EMAIL, emailVerified: true })
      .then(function (user) { return user.id; });
  });
}

function ready() {
  if (!state) {
    state = userData.database().then(function (db) {
      var auth = create(db);
      return auth.$context.then(function (ctx) {
        return ensureOwner(ctx, db).then(function (ownerId) {
          return { auth: auth, ctx: ctx, db: db, ownerId: ownerId };
        });
      });
    });
    state.catch(function (err) {
      log.error('auth unavailable: ' + err.message, { err: err });
      state = null;
    });
  }
  return state;
}

// stop(): the database closes, the next start makes a new instance
function close() {
  state = null;
}

// ── who is calling ─────────────────────────────────────────────────────────

function bearerToken(req) {
  var header = req.headers.authorization;
  if (header && /^bearer /i.test(header)) {
    return header.slice(7).trim() || null;
  }
  var q = req.query && req.query.access_token;
  return typeof q === 'string' && q ? q : null;
}

function present(row, session) {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name || null,
    platform: row.platform || null,
    client: row.client || null,
    clientDeviceId: row.clientDeviceId || null,
    capabilities: row.capabilities || null,
    address: row.address || null,
    lastProfileId: row.lastProfileId || null,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: session ? new Date(session.expiresAt).toISOString() : null
  };
}

function deviceBySession(s, sessionId) {
  return s.db.select().from(schema.devices).where(orm.eq(schema.devices.sessionId, sessionId)).limit(1)
    .then(function (rows) { return rows[0] || null; });
}

// A paired device's token → { device, session } or null
function fromToken(s, token, req) {
  return s.ctx.internalAdapter.findSession(token).then(function (found) {
    if (!found || new Date(found.session.expiresAt) <= new Date()) {
      return null;
    }
    var session = found.session;
    return deviceBySession(s, session.id).then(function (row) {
      if (!row) {
        return null;   // a session that isn't a device's (the admin's): not usable as a token
      }
      var now = Date.now(), writes = [],
        expiresIn = SESSION_DAYS * 24 * 3600 * 1000;
      // sliding expiry, like Better Auth's own updateAge
      if (new Date(session.expiresAt).getTime() - now < expiresIn - UPDATE_AGE_S * 1000) {
        session.expiresAt = new Date(now + expiresIn);
        writes.push(s.ctx.internalAdapter.updateSession(token, { expiresAt: session.expiresAt }));
      }
      var address = remoteAddress(req);
      if (now - row.lastSeenAt.getTime() > LAST_SEEN_EVERY_MS || row.address !== address) {
        row.lastSeenAt = new Date(now);
        row.address = address;
        writes.push(s.db.update(schema.devices).set({ lastSeenAt: row.lastSeenAt, address: address })
          .where(orm.eq(schema.devices.id, row.id)));
      }
      return Promise.all(writes).then(function () {
        return { device: row, session: session };
      });
    });
  });
}

// The dashboard's cookie session → { session, user } or null
function fromCookie(s, req) {
  if (!req.headers.cookie) {
    return Promise.resolve(null);
  }
  var headers = new Headers();
  headers.set('cookie', req.headers.cookie);
  headers.set('host', req.headers.host || 'localhost');
  return s.auth.api.getSession({ headers: headers }).then(function (found) {
    if (!found) {
      return null;
    }
    var session = found.session;
    if (Date.now() - new Date(session.createdAt).getTime() > ADMIN_SESSION_DAYS * 24 * 3600 * 1000) {
      return s.ctx.internalAdapter.deleteSession(session.token).then(function () { return null; });
    }
    return deviceBySession(s, session.id).then(function (row) {
      return row ? null : found;
    });
  }, function () { return null; });
}

/**
 * Who is calling: resolves req.auth (see the top of this file). Never rejects
 * the request itself; requireClient / requireAdmin do.
 */
function identify(req) {
  if (req.query && req.query.internal === internalToken && isLoopback(req)) {
    return Promise.resolve({ kind: 'internal' });
  }
  return ready().then(function (s) {
    var token = bearerToken(req);
    if (token) {
      return fromToken(s, token, req).then(function (found) {
        return found ? { kind: 'device', device: found.device, session: found.session } : null;
      });
    }
    return fromCookie(s, req).then(function (found) {
      if (found) {
        return { kind: 'admin', session: found.session, user: found.user };
      }
      if (isLoopback(req) && !settings.get('security.requirePairingOnLoopback')) {
        return { kind: 'local' };
      }
      return null;
    });
  });
}

// ── devices ────────────────────────────────────────────────────────────────

var DEVICE_FIELDS = { name: 64, platform: 32, clientDeviceId: 64 };

// PUT /devices/me: what the client says about itself
function describeDevice(deviceId, body) {
  body = body || {};
  var patch = {}, problems = [];
  Object.keys(DEVICE_FIELDS).forEach(function (k) {
    var v = body[k === 'clientDeviceId' ? 'deviceId' : k];
    if (v === undefined) {
      return;
    }
    if (v !== null && (typeof v !== 'string' || v.length > DEVICE_FIELDS[k])) {
      problems.push((k === 'clientDeviceId' ? 'deviceId' : k) + ' must be a string of at most ' + DEVICE_FIELDS[k] + ' characters');
      return;
    }
    patch[k] = v === null ? null : v.trim() || null;
  });
  if (body.capabilities !== undefined) {
    var caps = body.capabilities;
    if (caps !== null && (typeof caps !== 'object' || Array.isArray(caps) || JSON.stringify(caps).length > 4096)) {
      problems.push('capabilities must be an object (at most 4 KB of JSON)');
    } else {
      patch.capabilities = caps;
    }
  }
  if (problems.length) {
    var err = new Error(problems.join('; '));
    err.code = 'INVALID';
    return Promise.reject(err);
  }
  return ready().then(function (s) {
    var write = Object.keys(patch).length ?
      s.db.update(schema.devices).set(patch).where(orm.eq(schema.devices.id, deviceId)) : Promise.resolve();
    return write.then(function () { return getDevice(deviceId); });
  });
}

function getDevice(id) {
  return ready().then(function (s) {
    return s.db.select({ device: schema.devices, expiresAt: schema.authSession.expiresAt })
      .from(schema.devices)
      .innerJoin(schema.authSession, orm.eq(schema.devices.sessionId, schema.authSession.id))
      .where(orm.eq(schema.devices.id, id)).limit(1)
      .then(function (rows) {
        return rows[0] ? present(rows[0].device, { expiresAt: rows[0].expiresAt }) : null;
      });
  });
}

function listDevices() {
  return ready().then(function (s) {
    return s.db.select({ device: schema.devices, expiresAt: schema.authSession.expiresAt })
      .from(schema.devices)
      .innerJoin(schema.authSession, orm.eq(schema.devices.sessionId, schema.authSession.id))
      .orderBy(orm.desc(schema.devices.lastSeenAt))
      .then(function (rows) {
        return rows.filter(function (r) { return r.expiresAt > new Date(); })
          .map(function (r) { return present(r.device, { expiresAt: r.expiresAt }); });
      });
  });
}

function renameDevice(id, name) {
  if (typeof name !== 'string' || !name.trim() || name.length > DEVICE_FIELDS.name) {
    var err = new Error('name must be a non-empty string of at most ' + DEVICE_FIELDS.name + ' characters');
    err.code = 'INVALID';
    return Promise.reject(err);
  }
  return ready().then(function (s) {
    return s.db.update(schema.devices).set({ name: name.trim() }).where(orm.eq(schema.devices.id, id))
      .then(function () { return getDevice(id); });
  });
}

// Deletes the device's session (and with it its row): its token stops working
// at once. Its settings (device_settings, keyed by the id it sent, else its
// own id: lib/routes/settings.js) go too. true if there was one.
function revokeDevice(id) {
  return ready().then(function (s) {
    return s.db.select({ sessionId: schema.devices.sessionId, clientDeviceId: schema.devices.clientDeviceId })
      .from(schema.devices)
      .where(orm.eq(schema.devices.id, id)).limit(1)
      .then(function (rows) {
        if (!rows.length) {
          return false;
        }
        return s.db.batch([
          s.db.delete(schema.authSession).where(orm.eq(schema.authSession.id, rows[0].sessionId)),
          s.db.delete(schema.deviceSettings).where(orm.eq(schema.deviceSettings.deviceId, rows[0].clientDeviceId || id))
        ])
          .then(function () {
            log.info('device revoked: ' + id);
            events.publish('device.revoked', { id: id }, { admin: true });
            return true;
          });
      });
  });
}

// ── pairing requests ───────────────────────────────────────────────────────

function normalizeCode(code) {
  return String(code || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

// A new pairing request (POST /auth/device/code, hooks.after above): who
// asked, for the admin's list
function noteRequest(db, userCode, headers) {
  var client = protocol.parseClientHeader(headers && headers.get(protocol.CLIENT_HEADER)),
    info = {
      address: headers ? headers.get(ADDRESS_HEADER) : null,
      client: client && client.name ? client.name + (client.version ? '/' + client.version : '') : null,
      requestedAt: new Date()
    };
  return db.update(schema.authDeviceCode).set(info).where(orm.eq(schema.authDeviceCode.userCode, userCode))
    .then(function () {
      log.info('pairing requested: ' + userCode, { address: info.address, client: info.client });
      events.publish('pairing.requested', { userCode: userCode, address: info.address, client: info.client }, { admin: true });
    });
}

// Pending requests that haven't expired, oldest first. Requests expired for a
// day are deleted (a client still polling within that day gets expired_token).
function pendingRequests() {
  return ready().then(function (s) {
    var t = schema.authDeviceCode, now = new Date();
    return s.db.delete(t).where(orm.lt(t.expiresAt, new Date(now.getTime() - 24 * 3600 * 1000))).then(function () {
      return s.db.select().from(t).where(orm.and(orm.eq(t.status, 'pending'), orm.gt(t.expiresAt, now)))
        .orderBy(orm.asc(t.expiresAt));
    }).then(function (rows) {
      return rows.map(function (r) {
        return {
          userCode: r.userCode,
          clientId: r.clientId || null,
          client: r.client || null,
          address: r.address || null,
          requestedAt: r.requestedAt ? r.requestedAt.toISOString() : null,
          expiresAt: r.expiresAt.toISOString()
        };
      });
    });
  });
}

// Approves ('approved') or denies ('denied') a pending request. Rejects with
// err.code NOT_FOUND (no such pending code) or CONFLICT (already handled).
function decide(userCode, status) {
  return ready().then(function (s) {
    var code = normalizeCode(userCode);
    return s.ctx.adapter.findOne({ model: 'deviceCode', where: [{ field: 'userCode', value: code }] })
      .then(function (row) {
        var err;
        if (!row || new Date(row.expiresAt) <= new Date()) {
          err = new Error('No pairing request with code ' + code + ' (it may have expired)');
          err.code = 'NOT_FOUND';
          throw err;
        }
        if (row.status !== 'pending') {
          err = new Error('This pairing request was already ' + row.status);
          err.code = 'CONFLICT';
          throw err;
        }
        return s.ctx.adapter.update({
          model: 'deviceCode',
          where: [{ field: 'id', value: row.id }, { field: 'status', value: 'pending' }],
          update: { status: status, userId: s.ownerId }
        }).then(function () {
          log.info('pairing ' + code + ' ' + status);
          events.publish('pairing.' + status, { userCode: code }, { admin: true });
          return { ok: true };
        });
      });
  });
}

// ── admin account ──────────────────────────────────────────────────────────

function credential(s) {
  return s.ctx.internalAdapter.findAccounts(s.ownerId).then(function (accounts) {
    return accounts.filter(function (a) { return a.providerId === 'credential'; })[0] || null;
  });
}

// true until the admin has a password (first-run setup)
function setupNeeded() {
  return ready().then(function (s) {
    return credential(s).then(function (account) { return !account || !account.password; });
  });
}

function invalid(message) {
  var err = new Error(message);
  err.code = 'INVALID';
  return err;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw invalid('password must be 8 to 128 characters');
  }
}

// Stores the admin's password hash (a 'credential' account) and signs out
// every admin session; paired devices stay paired
function storePassword(s, password) {
  return s.ctx.password.hash(password).then(function (hash) {
    return credential(s).then(function (account) {
      return account ? s.ctx.internalAdapter.updatePassword(s.ownerId, hash) :
        s.ctx.internalAdapter.linkAccount({ userId: s.ownerId, providerId: 'credential', accountId: s.ownerId, password: hash });
    });
  }).then(function () { return signOutAdmins(s); });
}

// Sets the admin's username and password (first-run setup, CLI)
function setAdmin(name, password) {
  return ready().then(function (s) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_.]{3,30}$/.test(name)) {
      throw invalid('username must be 3 to 30 letters, digits, _ or .');
    }
    checkPassword(password);
    return s.ctx.internalAdapter.updateUser(s.ownerId, { username: name.toLowerCase(), displayUsername: name, name: name })
      .then(function () { return storePassword(s, password); })
      .then(function () {
        log.info('admin account set: ' + name);
        return { ok: true };
      });
  });
}

// Changes the admin's password after checking the current one
function changePassword(current, next) {
  return ready().then(function (s) {
    checkPassword(next);
    return credential(s).then(function (account) {
      return account && account.password && typeof current === 'string' ?
        s.ctx.password.verify({ hash: account.password, password: current }) : false;
    }).then(function (ok) {
      if (!ok) {
        var err = new Error('Wrong password');
        err.code = 'FORBIDDEN';
        throw err;
      }
      return storePassword(s, next);
    }).then(function () {
      log.info('admin password changed');
      return { ok: true };
    });
  });
}

// The owner's sessions that aren't devices
function signOutAdmins(s) {
  return s.db.select({ id: schema.authSession.id }).from(schema.authSession)
    .leftJoin(schema.devices, orm.eq(schema.devices.sessionId, schema.authSession.id))
    .where(orm.isNull(schema.devices.id))
    .then(function (rows) {
      if (!rows.length) {
        return;
      }
      return s.db.delete(schema.authSession).where(orm.inArray(schema.authSession.id, rows.map(function (r) { return r.id; })));
    });
}

module.exports = {
  ADDRESS_HEADER: ADDRESS_HEADER,
  EXPOSED: EXPOSED,
  ready: ready,
  close: close,
  identify: identify,
  isLoopback: isLoopback,
  remoteAddress: remoteAddress,
  internalUrlToken: function () { return internalToken; },
  // devices
  describeDevice: describeDevice,
  getDevice: getDevice,
  listDevices: listDevices,
  renameDevice: renameDevice,
  revokeDevice: revokeDevice,
  // pairing
  pendingRequests: pendingRequests,
  approve: function (code) { return decide(code, 'approved'); },
  deny: function (code) { return decide(code, 'denied'); },
  // admin account
  setupNeeded: setupNeeded,
  setAdmin: setAdmin,
  changePassword: changePassword
};
