import { environment } from '../../environments/environment';
import type { ConnectedServer, ConnectionState, PairingCode, PairingUpdate } from '../desktop';

// Playpex TV in a browser, served by the server at /tv/ (docs/web-client-plan.md
// §5): what the Electron shell does (apps/tv/electron/), done by the page.
//
//   - the server is the one that served the page (location.origin): no
//     discovery, no switching, same origin (no CORS, no Origin to strip)
//   - pairing: the RFC 8628 device flow from the page, asking for the token as
//     an httpOnly cookie (`cookie: true`): the page never sees it, and media
//     elements, hls.js and the WebSockets carry it by themselves
//   - every API call says `X-Playpex-Client` (webClientHeaders, added by
//     WebClientInterceptor): the server asks it of cookie-authenticated writes
//     (CSRF) and tells a paired browser from the admin's dashboard by it
//   - "Forget this browser" = POST /auth/device/logout (clears the cookie)
//
// The same constants as @playpex/protocol (index.js is Node's: not bundled here)

export const isWeb:boolean = !!(environment as { web?:boolean }).web;

const API_PREFIX = '/api/v1';
const API_VERSION = 2;                 // @playpex/protocol API_VERSION
const CLIENT_ID = 'playpex-web';       // AUTH.WEB_CLIENT_ID
const CLIENT_HEADER = 'X-Playpex-Client';
const DEVICE_HEADER = 'X-Playpex-Device';
const DEVICE_CODE_PATH = '/auth/device/code';
const DEVICE_TOKEN_PATH = '/auth/device/token';
const DEVICE_LOGOUT_PATH = '/auth/device/logout';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const DEVICE_KEY = 'playpex.deviceId';

/** The server's version: the page and the server ship together */
let version = '';

export function webOrigin():string {
  return window.location.origin;
}

export function webApi():string {
  return webOrigin() + API_PREFIX;
}

export function webDeviceId():string {
  let id:string | null = null;
  try { id = localStorage.getItem(DEVICE_KEY); } catch (e) { }
  if (!id) {
    id = 'web-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(DEVICE_KEY, id); } catch (e) { }
  }
  return id;
}

export function webClientHeader():string {
  return `${CLIENT_ID}/${version || '0'}; api=${API_VERSION}`;
}

export function webClientHeaders():{ [name:string]:string } {
  return { [CLIENT_HEADER]: webClientHeader(), [DEVICE_HEADER]: webDeviceId() };
}

function call(path:string, init:RequestInit = {}):Promise<{ status:number, body:any, headers:Headers }> {
  let headers = { ...webClientHeaders(), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as any || {}) };
  return fetch(webApi() + path, { credentials: 'same-origin', ...init, headers })
    .then(res => res.text().then(text => {
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (e) { }
      return { status: res.status, body, headers: res.headers };
    }));
}

function platformName():string {
  let ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'windows';
  if (/Android/.test(ua)) return 'android';
  if (/iPhone|iPad|Mac OS/.test(ua)) return /Mac OS/.test(ua) && !/Mobile/.test(ua) ? 'macos' : 'ios';
  if (/Linux|X11|CrOS/.test(ua)) return 'linux';
  return 'web';
}

// Before Angular boots (server-config.ts resolveServer): the page's server,
// and whether this browser may use it (401 PAIRING_REQUIRED → pair; 426 →
// incompatible)
export async function webConnection():Promise<ConnectionState> {
  let deviceId = webDeviceId();
  let base:ConnectionState = {
    server: null, reason: 'unreachable', detail: window.location.host, candidate: null,
    deviceId, deviceIdIsNew: false, tokenStorage: 'encrypted', version: '', platform: 'web',
  };
  let info:any;
  try {
    let answer = await call('/server');
    if (answer.status != 200 || !answer.body?.id) return base;
    info = answer.body;
  } catch (e) {
    return base;
  }
  version = info.version || '';
  let server:ConnectedServer = { id: info.id, name: info.name || window.location.host, url: webOrigin(), local: isLoopback(), paired: false };
  base = { ...base, version, detail: null, reason: null };
  if ((info.minApiVersion || 1) > API_VERSION) return { ...base, reason: 'incompatible', detail: 'CLIENT_TOO_OLD', candidate: server };
  try {
    // 200: a paired browser; 404: a local client (loopback, no pairing)
    let me = await call('/devices/me');
    if (me.status == 401) return { ...base, reason: 'pairing', candidate: server };
    if (me.status == 426) return { ...base, reason: 'incompatible', detail: me.body?.code || 'CLIENT_TOO_OLD', candidate: server };
    server.paired = me.status == 200;
    if (server.paired) describeDevice();
  } catch (e) {
    return { ...base, reason: 'unreachable', detail: server.name, candidate: server };
  }
  return { ...base, server };
}

function isLoopback():boolean {
  let host = window.location.hostname;
  return host == 'localhost' || host == '[::1]' || /^127\./.test(host);
}

// What this browser is and plays (PUT /devices/me), sent on every start: the
// play pipeline decides direct play / remux / transcode from it
export function describeDevice():Promise<void> {
  return call('/devices/me', {
    method: 'PUT',
    body: JSON.stringify({ platform: platformName(), deviceId: webDeviceId(), capabilities: browserCapabilities() }),
  }).then(() => undefined, () => undefined);
}

// Chromium's <video> plays Matroska (as Playpex TV's Electron does) without
// saying so in canPlayType / isTypeSupported
function chromium():boolean {
  let brands:{ brand:string }[] = (navigator as any).userAgentData?.brands || [];
  return brands.some(b => /Chromium/.test(b.brand)) || /Chrome\/|Chromium\//.test(navigator.userAgent);
}

// What this browser decodes, asked of the browser itself (not assumed)
export function browserCapabilities() {
  let video = document.createElement('video');
  let mse = (window as any).MediaSource;
  let can = (type:string) => !!(mse?.isTypeSupported?.(type)) || video.canPlayType(type) == 'probably';
  let pick = (table:{ [name:string]:string[] }) => Object.keys(table).filter(name => table[name].some(can));
  return {
    containers: pick({
      mp4: ['video/mp4; codecs="avc1.42E01E"'], m4v: ['video/mp4; codecs="avc1.42E01E"'],
      mov: ['video/quicktime; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.42E01E"'],
      mkv: ['video/x-matroska; codecs="avc1.42E01E"'], webm: ['video/webm; codecs="vp9"', 'video/webm; codecs="vp8"'],
    }).concat(chromium() && !can('video/x-matroska; codecs="avc1.42E01E"') ? ['mkv'] : []),
    video: pick({
      h264: ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.640028"'],
      hevc: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
      vp8: ['video/webm; codecs="vp8"'],
      vp9: ['video/webm; codecs="vp9"', 'video/mp4; codecs="vp09.00.10.08"'],
      av1: ['video/mp4; codecs="av01.0.05M.08"', 'video/webm; codecs="av01.0.05M.08"'],
    }),
    audio: pick({
      aac: ['audio/mp4; codecs="mp4a.40.2"'], mp3: ['audio/mpeg'], opus: ['audio/webm; codecs="opus"', 'audio/ogg; codecs="opus"'],
      vorbis: ['audio/webm; codecs="vorbis"', 'audio/ogg; codecs="vorbis"'], flac: ['audio/flac', 'audio/mp4; codecs="flac"'],
      ac3: ['audio/mp4; codecs="ac-3"'], eac3: ['audio/mp4; codecs="ec-3"'],
    }),
    // native HLS (Safari) or MSE for hls.js
    hls: video.canPlayType('application/vnd.apple.mpegurl') != '' || !!mse,
    maxHeight: Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1) >= 3000 ? 2160 : 1080,
  };
}

// ── pairing ────────────────────────────────────────────────────────────────

let session:{ cancelled:boolean, timer:any } | null = null;

export function cancelPairing() {
  if (session) {
    session.cancelled = true;
    clearTimeout(session.timer);
    session = null;
  }
}

// The device flow, as electron/pairing.js does it, but the server sets the
// token as a cookie (`cookie: true`) instead of handing it over
export function startPairing(server:ConnectedServer, onUpdate:(update:PairingUpdate) => void):Promise<PairingCode> {
  cancelPairing();
  let mine = { cancelled: false, timer: null as any };
  session = mine;
  let emit = (state:PairingUpdate['state'], message?:string) => {
    if (!mine.cancelled) onUpdate({ state, message: message || null, serverId: server.id });
  };
  return call(DEVICE_CODE_PATH, { method: 'POST', body: JSON.stringify({ client_id: CLIENT_ID }) }).then(res => {
    if (res.status == 429) {
      throw new Error('Too many pairing requests: try again in ' + (Number(res.headers.get('x-retry-after')) || 60) + ' s');
    }
    if (res.status != 200 || !res.body?.device_code) {
      throw new Error(res.body?.error_description || res.body?.error || `The server refused to pair (HTTP ${res.status})`);
    }
    let code = res.body;
    let interval = (code.interval || 5) * 1000;
    let expiresAt = Date.now() + code.expires_in * 1000;
    let poll = () => {
      if (mine.cancelled) return;
      if (Date.now() > expiresAt) return emit('expired');
      call(DEVICE_TOKEN_PATH, {
        method: 'POST',
        body: JSON.stringify({ grant_type: DEVICE_GRANT_TYPE, device_code: code.device_code, client_id: CLIENT_ID, cookie: true }),
      }).then(answer => {
        if (mine.cancelled) return;
        if (answer.status == 200 && answer.body?.token_type == 'cookie') {
          return describeDevice().then(() => emit('approved'));
        }
        switch (answer.body?.error) {
          case 'authorization_pending': break;
          case 'slow_down': interval += 5000; break;
          case 'expired_token':
          case 'invalid_grant': return emit('expired');
          case 'access_denied': return emit('denied');
          default:
            if (answer.status == 429) {
              interval = Math.max(interval, (Number(answer.headers.get('x-retry-after')) || 10) * 1000);
              break;
            }
            return emit('error', answer.body?.error_description || answer.body?.error || 'HTTP ' + answer.status);
        }
        mine.timer = setTimeout(poll, interval);
      }, () => {
        emit('waiting', `Can't reach ${server.name} right now, still trying…`);
        mine.timer = setTimeout(poll, interval);
      });
    };
    mine.timer = setTimeout(poll, interval);
    let uri = code.verification_uri_complete || code.verification_uri;
    return qrCode(uri).then(qr => ({
      userCode: code.user_code,
      verificationUri: code.verification_uri,
      verificationUriComplete: code.verification_uri_complete || null,
      expiresIn: code.expires_in,
      qr,
    }));
  });
}

function qrCode(text:string):Promise<string | null> {
  return import('qrcode').then((m:any) => (m.default || m).toDataURL(text, { margin: 1, width: 320 })).catch(() => null);
}

/** Forgets this browser on the server (revokes it, clears the cookie), then reloads */
export function forgetBrowser():Promise<void> {
  return call(DEVICE_LOGOUT_PATH, { method: 'POST' }).catch(() => null).then(() => {
    window.location.replace(window.location.pathname.replace(/\/[^/]*$/, '/'));
  });
}

/** Back to the app's start, connected (after pairing): the router needs a clean URL */
export function reloadWeb() {
  window.location.replace(document.baseURI || '/tv/');
}
