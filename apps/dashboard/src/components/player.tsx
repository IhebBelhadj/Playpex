import { useQuery } from '@tanstack/react-query'
import type Hls from 'hls.js'
import {
  Captions,
  Loader2,
  Maximize,
  Maximize2,
  Minimize2,
  Pause,
  PictureInPicture2,
  Play,
  Settings2,
  UserRound,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { API_PREFIX, api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { clock } from '@/lib/format'
import { cn } from '@/lib/utils'

// The dashboard's player (docs/dashboard-plan.md §5, step 5): a download's
// file while it downloads, a library file. It lives in AppLayout, so it
// stays docked while the admin moves between pages; Expand makes it a theatre
// over the page, the browser's picture-in-picture and full screen too.
//
// How it plays: GET /media/{ref}/playback with what this browser decodes →
// direct (the file's bytes), hls (a stream the server makes: video copied,
// audio to AAC; hls.js, or Safari's own; to seek outside it the player asks
// again with ?t=) or none (why, in words). Nothing is saved by default
// (decision B: the admin isn't a profile); "Watch as <profile>" (kept per
// browser) saves the position for that profile, where the server knows the
// title (`playback.title`), and offers to resume. A torrent's file shows what
// is downloaded on the timeline (GET /downloads/{h}/pieces). Leases: the
// device `dashboard-<id>`; closing the player releases the file (DELETE /media/{ref}).

export type PlayItem = {
  ref: string
  title: string
  /** a line under the title: the torrent, the folder */
  detail?: string
}

type Ctx = { item: PlayItem | null; play: (item: PlayItem) => void; close: () => void }

const PlayerContext = createContext<Ctx>({ item: null, play: () => {}, close: () => {} })

export function usePlayer() {
  return use(PlayerContext)
}

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

const DEVICE = deviceId()

const WATCH_KEY = 'playpex.dashboard.watchAs'

/** The profile this browser's player saves progress for, or null (nobody) */
function storedWatchAs(): string | null {
  try {
    return localStorage.getItem(WATCH_KEY)
  } catch {
    return null
  }
}

function storeWatchAs(id: string | null) {
  try {
    if (id) localStorage.setItem(WATCH_KEY, id)
    else localStorage.removeItem(WATCH_KEY)
  } catch {
    // a per-viewer convenience: chosen again next time
  }
}

/** The downloaded runs of one file's pieces, as fractions of the file: [[from, to]…] */
function downloadedRuns(p: Schemas['DownloadPieces'] | undefined, path: string): [number, number][] {
  const file = p?.files.find((f) => f.path === path)
  if (!p?.have || !file) return []
  const bits = atob(p.have)
  const has = (i: number) => (bits.charCodeAt(i >> 3) & (0x80 >> (i & 7))) !== 0
  const n = file.last - file.first + 1
  const runs: [number, number][] = []
  let start = -1
  for (let i = file.first; i <= file.last + 1; i++) {
    const on = i <= file.last && has(i)
    if (on && start < 0) start = i
    if (!on && start >= 0) {
      runs.push([(start - file.first) / n, (i - file.first) / n])
      start = -1
    }
  }
  return runs
}

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

const CAPS = typeof document !== 'undefined' ? capabilities() : {}

function media(ref: string, rest = '') {
  return `${API_PREFIX}/media/${encodeURIComponent(ref)}${rest}`
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<PlayItem | null>(null)
  const release = (ref: string) => {
    fetch(media(ref, `?device=${DEVICE}`), { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {})
  }
  const play = useCallback((next: PlayItem) => {
    setItem((current) => {
      if (current && current.ref !== next.ref) release(current.ref)
      return next
    })
  }, [])
  const close = useCallback(() => {
    setItem((current) => {
      if (current) release(current.ref)
      return null
    })
  }, [])
  // leaving the page releases it too
  useEffect(() => {
    if (!item) return
    const leave = () => release(item.ref)
    window.addEventListener('pagehide', leave)
    return () => window.removeEventListener('pagehide', leave)
  }, [item])
  const value = useMemo(() => ({ item, play, close }), [item, play, close])
  return (
    <PlayerContext value={value}>
      {children}
      {item && <PlayerDock key={item.ref} item={item} onClose={close} />}
    </PlayerContext>
  )
}

type Playback = Schemas['MediaPlayback']

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

function PlayerDock({ item, onClose }: { item: PlayItem; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const hls = useRef<Hls | null>(null)
  const [theatre, setTheatre] = useState(false)
  const [answer, setAnswer] = useState<Playback | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [buffered, setBuffered] = useState<[number, number][]>([])
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const [audio, setAudio] = useState(0)
  const [subtitle, setSubtitle] = useState<string>('off')
  const [hoverAt, setHoverAt] = useState<number | null>(null)
  const pending = useRef<number | null>(null)
  const [watchAs, setWatchAs] = useState<string | null>(storedWatchAs)
  const [resumeDismissed, setResumeDismissed] = useState(false)
  const lastPosition = useRef(0)

  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => unwrap(api.GET('/profiles')), staleTime: 60_000 })
  const profile = profiles.data?.profiles.find((p) => p.id === watchAs) ?? null
  const title = answer?.title ?? null
  const saving = !!(profile && title)

  const tracks = useQuery({
    queryKey: ['media-tracks', item.ref],
    queryFn: () => unwrap(api.GET('/media/{ref}/tracks', { params: { path: { ref: item.ref }, query: { device: DEVICE } as never } })),
    staleTime: 60_000,
  })

  // start: the playback answer for this browser, from `t` seconds
  const load = useCallback(
    (t: number, audioIndex: number) => {
      setLoading(true)
      setError(null)
      const query = new URLSearchParams({ ...CAPS, device: DEVICE, t: String(Math.max(0, t)), audio: String(audioIndex) })
      fetch(media(item.ref, `/playback?${query}`), { credentials: 'same-origin' })
        .then(async (res) => {
          const body = await res.json()
          if (!res.ok) throw new Error(body.error ?? `The server answered ${res.status}`)
          return body as Playback
        })
        .then(async (a) => {
          setAnswer(a)
          const el = video.current
          if (!el) return
          hls.current?.destroy()
          hls.current = null
          if (a.method === 'none' || !a.url) {
            setLoading(false)
            return
          }
          const url = `${a.url}${a.url.includes('?') ? '&' : '?'}device=${DEVICE}`
          // a direct file seeks itself; a stream starts where the server started it
          pending.current = a.method === 'direct' ? t : null
          // hls.js wherever MediaSource is (Chrome now says it plays HLS itself, and fails on these
          // streams); the browser's own player only without it (Safari on iPhone)
          const HlsJs = a.method === 'hls' ? (await import('hls.js')).default : null
          if (HlsJs && HlsJs.isSupported()) {
            const h = new HlsJs({ xhrSetup: (xhr) => xhr.setRequestHeader('X-Playpex-Device', DEVICE), lowLatencyMode: false })
            h.on(HlsJs.Events.ERROR, (_, data) => {
              if (data.fatal) setError(data.details === 'manifestLoadError' ? 'The server could not start the stream.' : `Playback stopped (${data.details}).`)
            })
            h.loadSource(url)
            h.attachMedia(el)
            hls.current = h
          } else {
            el.src = url
          }
          el.play().catch(() => {})
        })
        .catch((err) => {
          setLoading(false)
          setError(errorMessage(err))
        })
    },
    [item.ref],
  )

  useEffect(() => {
    load(0, 0)
    const el = video.current
    return () => {
      hls.current?.destroy()
      hls.current = null
      if (el) {
        el.removeAttribute('src')
        el.load()
      }
    }
  }, [load])

  // the server's Activity: what plays and where (every 60 s), for the profile it's watched as
  useEffect(() => {
    const send = () => {
      const el = video.current
      if (!el || !answer) return
      fetch(media(item.ref, `/keepalive?device=${DEVICE}`), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          positionS: position(),
          durationS: duration ?? undefined,
          paused: el.paused,
          title: item.title,
          profileId: saving ? profile!.id : undefined,
        }),
      }).catch(() => {})
    }
    send()
    const timer = setInterval(send, 60_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, item.ref, playing, saving])

  const offset = answer?.method === 'hls' ? answer.start : 0
  const duration = answer?.duration ?? (video.current && Number.isFinite(video.current.duration) ? video.current.duration : null)
  const position = () => offset + (video.current?.currentTime ?? 0)

  // "Watch as": the position saved for that profile (every 15 s while it plays,
  // on pause, on close), where the server knows the title. The latest values
  // in a ref: the close happens after the video element is gone.
  const saveProgress = useRef<() => void>(() => {})
  saveProgress.current = () => {
    const pos = lastPosition.current
    if (!profile || !title || !answer || !duration || pos < 5) return
    fetch(`${API_PREFIX}/profiles/${encodeURIComponent(profile.id)}/progress/${title.mediaType}/${title.tmdbId}`, {
      method: 'PUT',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        positionS: Math.round(pos),
        durationS: Math.round(duration),
        ...(title.mediaType === 'tv' && title.season !== null && title.episode !== null ? { season: title.season, episode: title.episode } : {}),
        ...(title.title ? { title: title.title } : {}),
        ...(title.posterPath ? { posterPath: title.posterPath } : {}),
        infoHash: answer.download?.infoHash ?? null,
        filePath: answer.download?.path ?? null,
        fileId: answer.fileId ?? null,
      }),
    }).catch(() => {})
  }
  useEffect(() => {
    if (!playing || !saving) return
    const timer = setInterval(() => saveProgress.current(), 15_000)
    return () => clearInterval(timer)
  }, [playing, saving])
  useEffect(() => () => saveProgress.current(), [])

  // where that profile stopped (offered once, under the video)
  const resume = useQuery({
    queryKey: ['progress', profile?.id, title?.mediaType, title?.tmdbId, title?.season, title?.episode],
    enabled: saving,
    // once per opening: the last one saved it
    staleTime: Infinity,
    gcTime: 0,
    queryFn: () =>
      unwrap(
        api.GET('/profiles/{profileId}/progress/{mediaType}/{tmdbId}', {
          params: {
            path: { profileId: profile!.id, mediaType: title!.mediaType, tmdbId: title!.tmdbId },
            query: title!.mediaType === 'tv' && title!.season !== null ? { season: title!.season, episode: title!.episode ?? undefined } : {},
          },
        }),
      ),
  })
  const resumeAt = saving && !resumeDismissed && resume.data?.resume && resume.data.resume.positionS > 30 ? resume.data.resume.positionS : null

  // a torrent's file: what of it is downloaded (the pieces), while it isn't all there
  const pieces = useQuery({
    queryKey: ['download-pieces', answer?.download?.infoHash],
    enabled: !!answer?.download,
    queryFn: () => unwrap(api.GET('/downloads/{infoHash}/pieces', { params: { path: { infoHash: answer!.download!.infoHash } } })),
    refetchInterval: (q) => {
      const runs = answer?.download ? downloadedRuns(q.state.data, answer.download.path) : []
      return runs.length === 1 && runs[0][0] === 0 && runs[0][1] === 1 ? false : 4000
    },
    retry: false,
  })
  const downloaded = answer?.download ? downloadedRuns(pieces.data, answer.download.path) : []
  const whole = downloaded.length === 1 && downloaded[0][0] === 0 && downloaded[0][1] === 1

  const seek = (t: number) => {
    const el = video.current
    if (!el || duration === null) return
    t = Math.max(0, Math.min(duration - 0.5, t))
    if (answer?.method === 'direct') {
      el.currentTime = t
      return
    }
    // inside what the stream holds: move there; else the server starts it again from t
    const local = t - offset
    const ranges = Array.from({ length: el.buffered.length }, (_, i) => [el.buffered.start(i), el.buffered.end(i)])
    if (local >= 0 && ranges.some(([a, b]) => local >= a && local <= b + 2)) el.currentTime = local
    else load(t, audio)
  }

  const togglePlay = () => {
    const el = video.current
    if (!el) return
    if (el.paused) el.play().catch(() => {})
    else el.pause()
  }

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = video.current
    if (!el || (e.target as HTMLElement).closest('input, [role=menu], [role=menuitemradio]')) return
    const step = (by: number) => seek(position() + by)
    switch (e.key) {
      case ' ':
      case 'k':
        e.preventDefault()
        return togglePlay()
      case 'ArrowLeft':
        e.preventDefault()
        return step(-10)
      case 'ArrowRight':
        e.preventDefault()
        return step(10)
      case 'ArrowUp':
        e.preventDefault()
        el.volume = Math.min(1, el.volume + 0.1)
        return
      case 'ArrowDown':
        e.preventDefault()
        el.volume = Math.max(0, el.volume - 0.1)
        return
      case 'm':
        el.muted = !el.muted
        return
      case 'f':
        return fullscreen()
      case 'c':
        return setSubtitle((s) => (s === 'off' ? (subtitleTracks[0]?.id ?? 'off') : 'off'))
      case 'Escape':
        if (theatre) {
          e.preventDefault()
          setTheatre(false)
        }
    }
  }

  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else frame.current?.requestFullscreen().catch(() => {})
  }
  const pip = () => {
    const el = video.current
    if (!el) return
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})
    else el.requestPictureInPicture?.().catch(() => {})
  }

  // subtitles: text tracks by the browser, shifted by the stream's start
  const subtitleTracks = (tracks.data?.subtitles ?? []).filter((s) => s.play === 'text' && s.available !== false)
  const subtitleUrl = (id: string) => {
    const track = subtitleTracks.find((s) => s.id === id)
    if (!track) return null
    return track.source === 'embedded'
      ? media(item.ref, `/subtitles/embedded/${track.index}?device=${DEVICE}`)
      : media(item.ref, `/subtitles/file/${id.slice(2)}?device=${DEVICE}`)
  }
  useEffect(() => {
    const el = video.current
    if (!el) return
    for (const t of Array.from(el.textTracks)) t.mode = 'disabled'
    if (subtitle === 'off') return
    const track = el.querySelector<HTMLTrackElement>(`track[data-id="${CSS.escape(subtitle)}"]`)
    if (!track) return
    const show = () => {
      const tt = track.track
      // the file's times → the stream's (it starts at `offset`), from what was shifted before
      const before = Number(track.dataset.shifted ?? 0)
      if (tt.cues && before !== offset) {
        for (const cue of Array.from(tt.cues)) {
          cue.startTime -= offset - before
          cue.endTime -= offset - before
        }
        track.dataset.shifted = String(offset)
      }
      tt.mode = 'showing'
    }
    track.track.mode = 'hidden'
    if (track.readyState === 2) show()
    else track.addEventListener('load', show, { once: true })
  }, [subtitle, offset, answer])

  const audioTracks = (tracks.data?.audio ?? []).filter((a) => a.source === 'embedded' && a.index !== undefined)
  const current = position()
  const fraction = (t: number) => (duration ? Math.max(0, Math.min(1, t / duration)) : 0)

  return (
    <>
      {theatre && <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={() => setTheatre(false)} aria-hidden />}
      <section
        aria-label={`Player: ${item.title}`}
        onKeyDown={keys}
        className={cn(
          'fixed z-50 overflow-hidden border bg-card shadow-2xl',
          theatre
            ? 'inset-x-4 top-1/2 mx-auto max-w-6xl -translate-y-1/2 rounded-xl md:inset-x-8'
            : 'inset-x-0 bottom-0 rounded-t-xl md:inset-x-auto md:right-4 md:bottom-4 md:w-[30rem] md:rounded-xl',
        )}
      >
        <div ref={frame} className="group/player relative bg-black" tabIndex={-1}>
          <video
            ref={video}
            className={cn('block aspect-video w-full bg-black', theatre && 'max-h-[75svh]')}
            playsInline
            onClick={togglePlay}
            onDoubleClick={fullscreen}
            onPlay={() => setPlaying(true)}
            onPause={() => {
              setPlaying(false)
              saveProgress.current()
            }}
            onWaiting={() => setLoading(true)}
            onPlaying={() => setLoading(false)}
            onCanPlay={() => setLoading(false)}
            onLoadedMetadata={(e) => {
              if (pending.current) e.currentTarget.currentTime = pending.current
              pending.current = null
              e.currentTarget.playbackRate = rate
            }}
            onTimeUpdate={(e) => {
              setTime(e.currentTarget.currentTime)
              lastPosition.current = offset + e.currentTarget.currentTime
            }}
            onProgress={(e) => {
              const b = e.currentTarget.buffered
              setBuffered(Array.from({ length: b.length }, (_, i) => [b.start(i), b.end(i)]))
            }}
            onVolumeChange={(e) => {
              setVolume(e.currentTarget.volume)
              setMuted(e.currentTarget.muted)
            }}
            onError={() => {
              if (answer?.method === 'direct') setError('This browser can’t play this file.')
            }}
          >
            {subtitleTracks.map((s) => (
              <track key={s.id} data-id={s.id} kind="subtitles" src={subtitleUrl(s.id) ?? undefined} srcLang={s.language ?? undefined} label={s.languageName ?? s.title ?? s.id} />
            ))}
          </video>
          {loading && !error && answer?.method !== 'none' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Loader2 className="size-8 animate-spin text-white/80" />
            </div>
          )}
          {resumeAt !== null && current < resumeAt - 5 && !error && (
            <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-full bg-black/75 py-1 pr-1 pl-3 text-xs text-white shadow">
              <button
                type="button"
                className="font-medium hover:underline"
                onClick={() => {
                  seek(resumeAt)
                  setResumeDismissed(true)
                }}
              >
                Resume at {clock(resumeAt)}
              </button>
              <span className="text-white/60">for {profile?.name}</span>
              <button type="button" aria-label="Start from here" className="rounded-full p-1 hover:bg-white/15" onClick={() => setResumeDismissed(true)}>
                <X className="size-3" />
              </button>
            </div>
          )}
          {(error || answer?.method === 'none') && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 p-6 text-center text-sm text-white">
              <p className="font-medium">{error ? 'It doesn’t play' : 'This browser can’t play it'}</p>
              <p className="max-w-sm text-white/70">{error ?? answer?.notes.join(' ')}</p>
              {error && (
                <Button size="sm" variant="secondary" onClick={() => load(current, audio)}>
                  Try again
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="space-y-1.5 px-3 pt-2 pb-2.5">
          {/* the timeline: what is downloaded (a torrent's file), what the browser holds, the position */}
          <div
            className="group/bar relative h-4 cursor-pointer touch-none"
            role="slider"
            tabIndex={0}
            aria-label="Position"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration ?? 0)}
            aria-valuenow={Math.round(current)}
            aria-valuetext={`${clock(current)} of ${clock(duration)}`}
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setHoverAt(((e.clientX - r.left) / r.width) * (duration ?? 0))
            }}
            onPointerLeave={() => setHoverAt(null)}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              seek(((e.clientX - r.left) / r.width) * (duration ?? 0))
            }}
          >
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-(--strip-track) transition-[height] group-hover/bar:h-1.5">
              {!whole &&
                downloaded.map(([a, b], i) => (
                  <span key={`d${i}`} className="absolute inset-y-0 bg-down/45" style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} />
                ))}
              {buffered.map(([a, b], i) => (
                <span
                  key={i}
                  className="absolute inset-y-0 rounded-full bg-muted-foreground/40"
                  style={{ left: `${fraction(offset + a) * 100}%`, width: `${(fraction(offset + b) - fraction(offset + a)) * 100}%` }}
                />
              ))}
              <span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${fraction(offset + time) * 100}%` }} />
            </div>
            {hoverAt !== null && duration ? (
              <span
                className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-popover px-1.5 py-0.5 text-[11px] tabular-nums shadow"
                style={{ left: `${fraction(hoverAt) * 100}%` }}
              >
                {clock(hoverAt)}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={togglePlay}>
              {playing ? <Pause /> : <Play />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
              title="Mute (M)"
              onClick={() => video.current && (video.current.muted = !video.current.muted)}
            >
              {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label="Volume"
              onChange={(e) => {
                const el = video.current
                if (!el) return
                el.volume = Number(e.target.value)
                el.muted = el.volume === 0
              }}
              className="hidden h-1 w-16 accent-primary sm:block"
            />
            <span className="ml-1 text-xs text-muted-foreground tabular-nums">
              {clock(current)} / {clock(duration)}
            </span>
            <div className="min-w-0 flex-1 truncate px-2 text-right text-xs" title={item.detail ? `${item.title}\n${item.detail}` : item.title}>
              <span className="font-medium">{item.title}</span>
              {saving && <span className="text-muted-foreground"> · as {profile!.name}</span>}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Sound, subtitles and speed" title="Sound, subtitles and speed">
                  {subtitle !== 'off' ? <Captions /> : <Settings2 />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="max-h-96 w-64 overflow-y-auto">
                {audioTracks.length > 1 && (
                  <>
                    <DropdownMenuLabel>Sound</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={String(audio)}
                      onValueChange={(v) => {
                        setAudio(Number(v))
                        load(position(), Number(v))
                      }}
                    >
                      {audioTracks.map((a) => (
                        <DropdownMenuRadioItem key={a.id} value={String(a.index)}>
                          {[a.languageName ?? a.language ?? `Track ${(a.index ?? 0) + 1}`, a.codec?.toUpperCase(), a.channels ? `${a.channels} ch` : null]
                            .filter(Boolean)
                            .join(' · ')}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuLabel>Subtitles</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={subtitle} onValueChange={setSubtitle}>
                  <DropdownMenuRadioItem value="off">Off</DropdownMenuRadioItem>
                  {subtitleTracks.map((s) => (
                    <DropdownMenuRadioItem key={s.id} value={s.id}>
                      {[s.languageName ?? s.language ?? s.title ?? s.id, s.forced ? 'forced' : null, s.sdh ? 'SDH' : null].filter(Boolean).join(' · ')}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {subtitleTracks.length === 0 && <p className="px-2 pb-1.5 text-xs text-muted-foreground">None this browser can show.</p>}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Watch as</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={profile ? profile.id : 'none'}
                  onValueChange={(v) => {
                    const id = v === 'none' ? null : v
                    saveProgress.current()
                    setWatchAs(id)
                    storeWatchAs(id)
                    setResumeDismissed(false)
                  }}
                >
                  <DropdownMenuRadioItem value="none">Nobody: nothing saved</DropdownMenuRadioItem>
                  {(profiles.data?.profiles ?? []).map((p) => (
                    <DropdownMenuRadioItem key={p.id} value={p.id}>
                      <UserRound className="size-3.5 text-muted-foreground" />
                      {p.name}
                      {p.isKid ? <span className="text-xs text-muted-foreground">kid</span> : null}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {profile && answer && !title && (
                  <p className="px-2 pb-1.5 text-xs text-muted-foreground">Playpex doesn’t know which title this file is: nothing is saved for {profile.name}.</p>
                )}
                {saving && <p className="px-2 pb-1.5 text-xs text-muted-foreground">Where you stop is saved for {profile!.name}: their Continue watching.</p>}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Speed</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={String(rate)}
                  onValueChange={(v) => {
                    setRate(Number(v))
                    if (video.current) video.current.playbackRate = Number(v)
                  }}
                >
                  {SPEEDS.map((s) => (
                    <DropdownMenuRadioItem key={s} value={String(s)}>
                      {s === 1 ? 'Normal' : `${s}×`}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {answer && answer.notes.length > 0 && answer.method !== 'none' && (
                  <>
                    <DropdownMenuSeparator />
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">{answer.notes.join(' ')}</p>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {'pictureInPictureEnabled' in document && document.pictureInPictureEnabled && (
              <Button variant="ghost" size="icon-sm" className="hidden sm:inline-flex" aria-label="Picture in picture" title="Picture in picture" onClick={pip}>
                <PictureInPicture2 />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="hidden md:inline-flex"
              aria-label={theatre ? 'Dock the player' : 'Expand the player'}
              title={theatre ? 'Dock (Esc)' : 'Expand'}
              onClick={() => setTheatre((t) => !t)}
            >
              {theatre ? <Minimize2 /> : <Maximize2 />}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Full screen" title="Full screen (F)" onClick={fullscreen}>
              <Maximize />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Close the player" title="Close" onClick={onClose}>
              <X />
            </Button>
          </div>
        </div>
      </section>
    </>
  )
}
