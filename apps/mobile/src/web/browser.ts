// Playpex Mobile in a browser (docs/mobile-web-plan.md): what the page knows
// about where it runs. The server is the one that served the page (no
// discovery, no other server: the device cookie is this origin's), and the
// browser decodes only what its <video> does (asked of it, not assumed).

/** Shared with Playpex TV on the web (apps/tv/src/app/web/web-client.ts): one browser, one device */
const DEVICE_KEY = 'playpex.deviceId'

/** The device flow's client for browsers (@playpex/protocol AUTH.WEB_CLIENT_ID): the server names the device after the browser */
export const WEB_CLIENT_ID = 'playpex-web'

export function pageOrigin(): string {
  return window.location.origin
}

export function browserDeviceId(): string {
  let id: string | null = null
  try {
    id = localStorage.getItem(DEVICE_KEY)
  } catch {}
  if (!id) {
    id = 'web-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
    try {
      localStorage.setItem(DEVICE_KEY, id)
    } catch {}
  }
  return id
}

export function isLoopback(): boolean {
  const host = window.location.hostname
  return host === 'localhost' || host === '[::1]' || /^127\./.test(host)
}

export function platformName(): string {
  const ua = navigator.userAgent
  if (/Android/.test(ua)) return 'android'
  if (/iPhone|iPad/.test(ua) || (/Mac OS/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/Windows/.test(ua)) return 'windows'
  if (/Mac OS/.test(ua)) return 'macos'
  if (/Linux|X11|CrOS/.test(ua)) return 'linux'
  return 'web'
}

/** A name for people: the browser on its system */
export function browserName(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const system = { android: 'Android', ios: 'iPhone', windows: 'Windows', macos: 'Mac', linux: 'Linux', web: '' }[platformName()] ?? ''
  return system ? `${browser} on ${system}` : browser
}

/** Chromium's <video> plays Matroska without saying so in canPlayType / isTypeSupported */
function chromium(): boolean {
  const brands: { brand: string }[] = (navigator as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands ?? []
  return brands.some((b) => /Chromium/.test(b.brand)) || /Chrome\/|Chromium\//.test(navigator.userAgent)
}

export type BrowserCapabilities = { containers: string[]; video: string[]; audio: string[]; hls: boolean; maxHeight: number }

let cached: BrowserCapabilities | null = null

/** What this browser decodes, in ffprobe's names */
export function browserCapabilities(): BrowserCapabilities {
  if (cached) return cached
  const video = document.createElement('video')
  const mse = (window as { MediaSource?: { isTypeSupported?: (t: string) => boolean } }).MediaSource
  const can = (type: string) => !!mse?.isTypeSupported?.(type) || video.canPlayType(type) === 'probably'
  const pick = (table: Record<string, string[]>) => Object.keys(table).filter((name) => table[name].some(can))
  const containers = pick({
    mp4: ['video/mp4; codecs="avc1.42E01E"'],
    m4v: ['video/mp4; codecs="avc1.42E01E"'],
    mov: ['video/quicktime; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.42E01E"'],
    mkv: ['video/x-matroska; codecs="avc1.42E01E"'],
    webm: ['video/webm; codecs="vp9"', 'video/webm; codecs="vp8"'],
  })
  if (chromium() && !containers.includes('mkv')) containers.push('mkv')
  cached = {
    containers,
    video: pick({
      h264: ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.640028"'],
      hevc: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
      vp8: ['video/webm; codecs="vp8"'],
      vp9: ['video/webm; codecs="vp9"', 'video/mp4; codecs="vp09.00.10.08"'],
      av1: ['video/mp4; codecs="av01.0.05M.08"', 'video/webm; codecs="av01.0.05M.08"'],
    }),
    audio: pick({
      aac: ['audio/mp4; codecs="mp4a.40.2"'],
      mp3: ['audio/mpeg'],
      opus: ['audio/webm; codecs="opus"', 'audio/ogg; codecs="opus"'],
      vorbis: ['audio/webm; codecs="vorbis"', 'audio/ogg; codecs="vorbis"'],
      flac: ['audio/flac', 'audio/mp4; codecs="flac"'],
      ac3: ['audio/mp4; codecs="ac-3"'],
      eac3: ['audio/mp4; codecs="ec-3"'],
    }),
    // native HLS (Safari) or MSE for hls.js
    hls: video.canPlayType('application/vnd.apple.mpegurl') !== '' || !!mse,
    maxHeight: Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1) >= 3000 ? 2160 : 1080,
  }
  return cached
}
