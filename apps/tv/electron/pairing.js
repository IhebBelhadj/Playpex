'use strict';

// Pairing with a server (docs/api/auth.md): the RFC 8628 device flow, run in
// the main process so the token never reaches the renderer.
//
//   pairing.start(server, onUpdate) → Promise<{ userCode, verificationUri, verificationUriComplete, expiresIn, qr }>
//   pairing.cancel()
//   onUpdate({ state, message, serverId })
//     state: waiting | approved | denied | expired | error
//
// Approved: the token is stored (clientConfig), then `PUT /devices/me` names
// this device and lists what it can decode (Chromium's codecs).

const protocol = require('@playpex/protocol');
const QRCode = require('qrcode');
const config = require('./clientConfig');

const CLIENT_ID = 'playpex-tv';
const REQUEST_TIMEOUT_MS = 8000;

// What Chromium (Electron) plays, in ffprobe's names (docs/api/auth.md)
const CAPABILITIES = {
  containers: ['mp4', 'm4v', 'mov', 'mkv', 'webm'],
  video: ['h264', 'hevc', 'vp8', 'vp9', 'av1'],
  audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac'],
  maxHeight: 2160
};

let session = null;   // { id, timer, cancelled }

function request(url, options) {
  return fetch(url, Object.assign({ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, options))
    .then(res => res.text().then(text => {
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (e) { /* not JSON */ }
      return { status: res.status, headers: res.headers, body };
    }));
}

function headers(clientHeader, extra) {
  return Object.assign({
    'Content-Type': 'application/json',
    [protocol.CLIENT_HEADER]: clientHeader
  }, extra || {});
}

function describeDevice(server, token, clientHeader) {
  return request(server.url + protocol.API_PREFIX + '/devices/me', {
    method: 'PUT',
    headers: headers(clientHeader, { Authorization: 'Bearer ' + token }),
    body: JSON.stringify({
      name: config.deviceName(),
      platform: { win32: 'windows', darwin: 'macos' }[process.platform] || process.platform,
      deviceId: config.deviceId(),
      capabilities: CAPABILITIES
    })
  }).catch(() => null);   // the name can be sent again later; pairing worked
}

function cancel() {
  if (session) {
    session.cancelled = true;
    clearTimeout(session.timer);
    session = null;
  }
}

function start(server, clientHeader, onUpdate) {
  cancel();
  const mine = { id: server.id, timer: null, cancelled: false };
  session = mine;
  const api = server.url + protocol.API_PREFIX;
  const emit = (state, message) => {
    if (!mine.cancelled) {
      onUpdate({ state, message: message || null, serverId: server.id });
    }
  };

  return request(api + protocol.AUTH.DEVICE_CODE_PATH, {
    method: 'POST',
    headers: headers(clientHeader),
    body: JSON.stringify({ client_id: CLIENT_ID })
  }).then(res => {
    if (res.status === 429) {
      const wait = Number(res.headers.get('x-retry-after')) || 60;
      throw new Error('Too many pairing requests: try again in ' + wait + ' s');
    }
    if (res.status !== 200 || !res.body || !res.body.device_code) {
      throw new Error((res.body && (res.body.error_description || res.body.error)) || 'The server refused to pair (HTTP ' + res.status + ')');
    }
    const code = res.body;
    let interval = (code.interval || 5) * 1000;
    const expiresAt = Date.now() + code.expires_in * 1000;

    const poll = () => {
      if (mine.cancelled) {
        return;
      }
      if (Date.now() > expiresAt) {
        return emit('expired');
      }
      request(api + protocol.AUTH.DEVICE_TOKEN_PATH, {
        method: 'POST',
        headers: headers(clientHeader),
        body: JSON.stringify({ grant_type: protocol.AUTH.DEVICE_GRANT_TYPE, device_code: code.device_code, client_id: CLIENT_ID })
      }).then(res => {
        if (mine.cancelled) {
          return;
        }
        if (res.status === 200 && res.body && res.body.access_token) {
          const token = res.body.access_token;
          config.saveServer(server.id, { name: server.name, url: server.url });
          config.setToken(server.id, token);
          return describeDevice(server, token, clientHeader).then(() => emit('approved'));
        }
        const error = res.body && res.body.error;
        switch (error) {
          case 'authorization_pending':
            break;
          case 'slow_down':
            interval += 5000;
            break;
          case 'expired_token':
          case 'invalid_grant':
            return emit('expired');
          case 'access_denied':
            return emit('denied');
          default:
            if (res.status === 429) {
              interval = Math.max(interval, (Number(res.headers.get('x-retry-after')) || 10) * 1000);
              break;
            }
            return emit('error', (res.body && (res.body.error_description || res.body.error)) || 'HTTP ' + res.status);
        }
        mine.timer = setTimeout(poll, interval);
      }, () => {
        // the server or the network hiccupped: keep trying until the code expires
        emit('waiting', 'Can\'t reach ' + server.name + ' right now, still trying…');
        mine.timer = setTimeout(poll, interval);
      });
    };
    mine.timer = setTimeout(poll, interval);

    return QRCode.toDataURL(code.verification_uri_complete || code.verification_uri, { margin: 1, width: 320 })
      .catch(() => null)
      .then(qr => ({
        userCode: code.user_code,
        verificationUri: code.verification_uri,
        verificationUriComplete: code.verification_uri_complete || null,
        expiresIn: code.expires_in,
        qr
      }));
  });
}

module.exports = { start, cancel, CLIENT_ID };
