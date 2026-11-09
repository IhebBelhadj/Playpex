'use strict';

// Every request the renderer makes to the current server (fetch / XHR,
// <video>, <track>, images) gets this client's headers here, in the main
// process (docs/server-separation-plan.md §10.1), so the renderer never sees
// the device token and media URLs carry no `?access_token=`:
//
//   Authorization: Bearer <token>       paired servers (none for a local one)
//   X-Playpex-Client: playpex-tv/<version>; api=<n>
//   X-Playpex-Device: <deviceId>        whose torrent leases these are
//
// CORS: the page is a file:// document, a cross-origin caller for the server.
// Its `Origin` is removed (the server treats the app like any non-browser
// client) and the answers get the CORS headers Chromium checks, preflights
// included. The server's CORS allow list therefore no longer needs `null` /
// `file://`, which any sandboxed iframe on the web can also send.
//
// Only the app's own document: the token and the CORS answers go with requests
// of its top frame (and requests with no frame: the shell's own, a file:// page's
// media). A frame inside it (the server's embed page, YouTube's player in it:
// a plugin's embed source) is someone else's code: its requests to the server
// leave without the token or the device id and get no CORS answer, so they are
// a stranger's (401 on everything but the public routes).
//
//   auth.install(session, () => ({ origin, token, deviceId }), clientHeader)   origin null = no server

const protocol = require('@playpex/protocol');

const ALLOW_HEADERS = ['Authorization', 'Content-Type', 'Accept', 'Range', 'X-Requested-With',
  protocol.CLIENT_HEADER, protocol.DEVICE_HEADER].join(', ');

const URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'];

// The request comes from the app's own document, not from a frame inside it.
// A frame's own document (a subFrame load: the server's embed page) is public
// and gets nothing either.
function fromApp(details) {
  if (!details) {
    return true;
  }
  if (details.resourceType === 'subFrame') {
    return false;
  }
  let frame = null;
  try {
    frame = details.frame || null;
  } catch (e) {
    return false;
  }
  if (!frame) {
    // no frame known (the shell's own requests, a frame already gone): only
    // when nothing on the web asked for it
    const referrer = details.referrer || '';
    return !referrer || referrer.startsWith('file://') || referrer.startsWith('devtools://');
  }
  try {
    return frame.parent === null;
  } catch (e) {
    return false;
  }
}

function install(session, current, clientHeader) {
  // the events WebSocket (ws://<server>/api/v1/events) counts as the server too
  const ours = (url, details) => {
    const state = current();
    const http = url.replace(/^ws(s?):/, 'http$1:');
    if (!state || !state.origin || !(http === state.origin || http.startsWith(state.origin + '/'))) {
      return null;
    }
    return fromApp(details) ? state : null;
  };

  session.webRequest.onBeforeSendHeaders({ urls: URLS }, (details, callback) => {
    const state = ours(details.url, details);
    if (!state) {
      return callback({});
    }
    const headers = Object.assign({}, details.requestHeaders);
    Object.keys(headers).forEach(name => {
      if (/^origin$/i.test(name)) {
        delete headers[name];
      }
    });
    if (details.method === 'OPTIONS') {
      // a CORS preflight: answered below, the server only has to accept it
      return callback({ requestHeaders: headers });
    }
    headers[protocol.CLIENT_HEADER] = clientHeader;
    headers[protocol.DEVICE_HEADER] = state.deviceId;
    if (state.token) {
      headers.Authorization = 'Bearer ' + state.token;
    }
    callback({ requestHeaders: headers });
  });

  session.webRequest.onHeadersReceived({ urls: URLS }, (details, callback) => {
    if (!ours(details.url, details)) {
      return callback({});
    }
    const headers = {};
    Object.keys(details.responseHeaders || {}).forEach(name => {
      if (!/^access-control-/i.test(name)) {
        headers[name] = details.responseHeaders[name];
      }
    });
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['OPTIONS, HEAD, GET, POST, PUT, PATCH, DELETE'];
    headers['Access-Control-Allow-Headers'] = [ALLOW_HEADERS];
    headers['Access-Control-Expose-Headers'] = ['Content-Length, Content-Range, Accept-Ranges, WWW-Authenticate'];
    const result = { responseHeaders: headers };
    if (details.method === 'OPTIONS') {
      result.statusLine = 'HTTP/1.1 204 No Content';
    }
    callback(result);
  });
}

module.exports = { install };
