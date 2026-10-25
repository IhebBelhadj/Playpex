import { API_PREFIX } from '@/lib/api'

// What the player (pages/watch.tsx) and its subtitles panel share: this
// browser's device id for the server's leases, what its video element
// decodes, media URLs, TMDB images.

const DEVICE_KEY = 'playpex.dashboard.device'

/** This browser's device id for the server's leases: dashboard-<random>, kept per browser */
function deviceId(): string {
  try {
    const known = localStorage.getItem(DEVICE_KEY)
    if (known && /^dashboard-[a-z0-9]{8,24}$/.test(known)) return known
    const made = `dashboard-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
    localStorage.setItem(DEVICE_KEY, made)
    return made
  } catch {
    return `dashboard-${Math.random().toString(36).slice(2, 12)}`
  }
}

export const DEVICE = deviceId()

/** What this browser's video element decodes beyond what every browser does */
function capabilities(): Record<string, string> {
  const v = document.createElement('video')
  const can = (type: string) => v.canPlayType(type) !== '' || (window.MediaSource?.isTypeSupported?.(type) ?? false)
  const caps: Record<string, boolean> = {
    mkv: can('video/x-matroska; codecs="avc1.42E01E, mp4a.40.2"') || can('video/webm; codecs="avc1.42E01E"'),
    hevc: can('video/mp4; codecs="hvc1.1.6.L93.B0"') || can('video/mp4; codecs="hev1.1.6.L93.B0"'),
    ac3: can('audio/mp4; codecs="ac-3"'),
    eac3: can('audio/mp4; codecs="ec-3"'),
  }
  return Object.fromEntries(Object.entries(caps).map(([k, on]) => [k, on ? '1' : '0']))
}

export const CAPS = typeof document !== 'undefined' ? capabilities() : {}

export function mediaUrl(ref: string, rest = '') {
  return `${API_PREFIX}/media/${encodeURIComponent(ref)}${rest}`
}

/** Lets the server know this browser no longer plays the file (its lease) */
export function release(ref: string) {
  fetch(mediaUrl(ref, `?device=${DEVICE}`), { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {})
}

export const TMDB_IMAGES = 'https://image.tmdb.org/t/p/'

export function tmdbImage(path: string | null | undefined, size: 'w92' | 'w185' | 'w342' | 'w780' | 'w1280'): string | null {
  return path ? `${TMDB_IMAGES}${size}${path}` : null
}

/** "S02E04" */
export function episodeCode(season: number | null | undefined, episode: number | null | undefined): string {
  return `S${String(season ?? 0).padStart(2, '0')}E${String(episode ?? 0).padStart(2, '0')}`
}
