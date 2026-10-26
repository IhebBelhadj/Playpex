import { useQuery } from '@tanstack/react-query'
import type Hls from 'hls.js'
import {
  ArrowLeft,
  Captions,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Settings2,
  UserRound,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { SIZES, SubtitlePanel, type SizeId, type SubtitleChoice } from '@/components/subtitle-panel'
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
import { CAPS, DEVICE, mediaUrl, release } from '@/lib/media'
import type { PlayItem } from '@/lib/player'
import { cn } from '@/lib/utils'

// The dashboard's player, a page of its own like Playpex TV's (/watch/<ref>):
// a download's file while it downloads, a library file, any video of the
// Library's places. The page is the stage: the video fills it, the controls
// sit over it and step aside while it plays, the subtitles panel opens beside it.
//
// How it plays: GET /media/{ref}/playback with what this browser decodes →
// direct (the file's bytes), hls (a stream the server makes: video copied,
// audio to AAC; hls.js, or Safari's own; to seek outside it the player asks
// again with ?t=) or none (why, in words). Nothing is saved by default
// (decision B: the admin isn't a profile); "Watch as <profile>" (kept per
// browser) saves the position for that profile, where the server knows the
// title (`playback.title`), and offers to resume. A torrent's file shows what
// is downloaded on the timeline (GET /downloads/{h}/pieces). Subtitles: the
// file's own, or added here (components/subtitle-panel.tsx). Leases: the
// device `dashboard-<id>`; leaving the page releases the file (DELETE /media/{ref}).

const WATCH_KEY = 'playpex.dashboard.watchAs'
const SUBTITLE_SIZE_KEY = 'playpex.dashboard.subtitleSize'

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
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

type Playback = Schemas['MediaPlayback']

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

export function WatchPage() {
  const { ref } = useParams()
  const [params] = useSearchParams()
  if (!ref) return null
  const item: PlayItem = {
    ref,
    title: params.get('title') ?? 'Video',
    detail: params.get('detail') ?? undefined,
    place: params.get('place') ?? undefined,
    dir: params.get('dir') ?? undefined,
  }
  return <Player key={ref} item={item} />
}

function Player({ item }: { item: PlayItem }) {
  const navigate = useNavigate()
  const video = useRef<HTMLVideoElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const hls = useRef<Hls | null>(null)
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
  const [hoverAt, setHoverAt] = useState<number | null>(null)
  const [idle, setIdle] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [full, setFull] = useState(false)
  const pending = useRef<number | null>(null)
  const [watchAs, setWatchAs] = useState<string | null>(() => stored(WATCH_KEY))
  const [resumeDismissed, setResumeDismissed] = useState(false)
  const lastPosition = useRef(0)

  // subtitles: the one shown, its timing and size, the ones added on this page
  const [panel, setPanel] = useState(false)
  const [subtitle, setSubtitle] = useState('off')
  const [delay, setDelay] = useState(0)
  const [size, setSize] = useState<SizeId>(() => (SIZES.some((s) => s.id === stored(SUBTITLE_SIZE_KEY)) ? (stored(SUBTITLE_SIZE_KEY) as SizeId) : 'm'))
  const [added, setAdded] = useState<SubtitleChoice[]>([])
  const addedRef = useRef(added)
  addedRef.current = added
  useEffect(() => () => addedRef.current.forEach((c) => URL.revokeObjectURL(c.url)), [])

  // a cinema: dark whatever the dashboard's theme, the title in the tab
  useEffect(() => {
    const root = document.documentElement
    const wasDark = root.classList.contains('dark')
    const before = document.title
    root.classList.add('dark')
    document.title = `${item.title} · Playpex`
    return () => {
      if (!wasDark) root.classList.remove('dark')
      document.title = before
    }
  }, [item.title])

  // leaving the page (another page, closing the tab) releases the file
  useEffect(() => {
    const leave = () => release(item.ref)
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      leave()
    }
  }, [item.ref])

  const back = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate('/library')
  }, [navigate])

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
      fetch(mediaUrl(item.ref, `/playback?${query}`), { credentials: 'same-origin' })
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

  const offset = answer?.method === 'hls' ? answer.start : 0
  const duration = answer?.duration ?? (video.current && Number.isFinite(video.current.duration) ? video.current.duration : null)
  const position = () => offset + (video.current?.currentTime ?? 0)

  // the server's Activity: what plays and where (every 60 s), for the profile it's watched as
  useEffect(() => {
    const send = () => {
      const el = video.current
      if (!el || !answer) return
      fetch(mediaUrl(item.ref, `/keepalive?device=${DEVICE}`), {
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

  // "Watch as": the position saved for that profile (every 15 s while it plays,
  // on pause, on leaving), where the server knows the title. The latest values
  // in a ref: leaving happens after the video element is gone.
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

  // where that profile stopped (offered once, over the video)
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

  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else stage.current?.parentElement?.requestFullscreen().catch(() => {})
  }
  useEffect(() => {
    const changed = () => setFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])
  const pip = () => {
    const el = video.current
    if (!el) return
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})
    else el.requestPictureInPicture?.().catch(() => {})
  }

  // subtitles: the file's own text tracks, then the added ones
  const choices = useMemo<SubtitleChoice[]>(() => {
    const own = (tracks.data?.subtitles ?? [])
      .filter((s) => s.play === 'text' && s.available !== false)
      .map((s) => ({
        id: s.id,
        label: s.languageName ?? s.language ?? s.title ?? s.id,
        detail: [s.source === 'embedded' ? 'In the file' : s.name?.split('/').pop(), s.forced ? 'forced' : null, s.sdh ? 'SDH' : null, s.title].filter(Boolean).join(' · '),
        url:
          s.source === 'embedded'
            ? mediaUrl(item.ref, `/subtitles/embedded/${s.index}?device=${DEVICE}`)
            : mediaUrl(item.ref, `/subtitles/file/${s.id.slice(2)}?device=${DEVICE}`),
        language: s.language,
        origin: 'file' as const,
      }))
    return [...own, ...added]
  }, [tracks.data, added, item.ref])

  // the chosen track's cues, moved by the stream's start and the timing chosen; the page
  // draws them (above the controls while they show), the browser only keeps time
  const [cues, setCues] = useState<string[]>([])
  useEffect(() => {
    const el = video.current
    setCues([])
    if (!el) return
    for (const t of Array.from(el.textTracks)) t.mode = 'disabled'
    if (subtitle === 'off') return
    const track = el.querySelector<HTMLTrackElement>(`track[data-id="${CSS.escape(subtitle)}"]`)
    if (!track) return
    const tt = track.track
    const shift = offset - delay
    const changed = () => setCues(Array.from(tt.activeCues ?? []).map((c) => (c as VTTCue).text.replace(/<[^>]+>/g, '')))
    const show = () => {
      const before = Number(track.dataset.shifted ?? 0)
      if (tt.cues && before !== shift) {
        for (const cue of Array.from(tt.cues)) {
          cue.startTime -= shift - before
          cue.endTime -= shift - before
        }
        track.dataset.shifted = String(shift)
      }
      changed()
    }
    tt.mode = 'hidden'
    tt.addEventListener('cuechange', changed)
    if (track.readyState === 2) show()
    else track.addEventListener('load', show, { once: true })
    return () => {
      tt.removeEventListener('cuechange', changed)
      track.removeEventListener('load', show)
    }
  }, [subtitle, offset, delay, answer, choices])

  const chooseSubtitle = (id: string) => setSubtitle(id)
  const chooseSize = (s: SizeId) => {
    setSize(s)
    store(SUBTITLE_SIZE_KEY, s)
  }

  // the controls step aside while it plays and nothing moves
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wake = useCallback(() => {
    setIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setIdle(true), 2500)
  }, [])
  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
  }, [])
  const chrome = !idle || !playing || menuOpen || !!error || answer?.method === 'none'

  // the page's keys
  const keysRef = useRef<(e: globalThis.KeyboardEvent) => void>(() => {})
  keysRef.current = (e) => {
    const el = video.current
    const target = e.target as HTMLElement
    if (!el || e.ctrlKey || e.metaKey || e.altKey || target.closest('input, textarea, select, [role=dialog], [role=menu], [role=listbox]')) return
    const step = (by: number) => seek(position() + by)
    wake()
    switch (e.key) {
      case ' ':
      case 'k':
        if (target.closest('button')) return
        e.preventDefault()
        return togglePlay()
      case 'ArrowLeft':
      case 'j':
        e.preventDefault()
        return step(-10)
      case 'ArrowRight':
      case 'l':
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
        return setSubtitle((s) => (s === 'off' ? (choices[0]?.id ?? 'off') : 'off'))
      case 's':
        return setPanel((p) => !p)
      case 'g':
        return setDelay((d) => d - 0.25)
      case 'h':
        return setDelay((d) => d + 0.25)
      case 'Escape':
        if (panel) return setPanel(false)
        if (document.fullscreenElement) return
        return back()
    }
  }
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => keysRef.current(e)
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const audioTracks = (tracks.data?.audio ?? []).filter((a) => a.source === 'embedded' && a.index !== undefined)
  const current = position()
  const fraction = (t: number) => (duration ? Math.max(0, Math.min(1, t / duration)) : 0)
  const cueSize = SIZES.find((s) => s.id === size)!.css

  return (
    <div className="fixed inset-0 flex bg-black text-white">
      <div
        ref={stage}
        className={cn('relative min-w-0 flex-1 overflow-hidden', !chrome && 'cursor-none')}
        onPointerMove={wake}
        onPointerDown={wake}
      >
        <video
          ref={video}
          className="absolute inset-0 size-full bg-black object-contain"
          playsInline
          onClick={togglePlay}
          onDoubleClick={fullscreen}
          onPlay={() => {
            setPlaying(true)
            wake()
          }}
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
          {choices.map((s) => (
            <track key={s.id} data-id={s.id} kind="subtitles" src={s.url} srcLang={s.language ?? undefined} label={s.label} />
          ))}
        </video>

        {cues.length > 0 && (
          <div
            aria-live="polite"
            className={cn('pointer-events-none absolute inset-x-0 flex flex-col items-center gap-1 px-6 text-center transition-[bottom] duration-300', chrome ? 'bottom-28' : 'bottom-10')}
            style={{ fontSize: cueSize }}
          >
            {cues.map((text, i) => (
              <p key={i} className="max-w-[80%] rounded bg-black/70 px-2 py-0.5 leading-snug font-medium whitespace-pre-line text-white [text-shadow:0_1px_2px_rgb(0_0_0/60%)]">
                {text}
              </p>
            ))}
          </div>
        )}

        {loading && !error && answer?.method !== 'none' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-10 animate-spin text-white/80" />
          </div>
        )}

        {(error || answer?.method === 'none') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-6 text-center">
            <p className="text-lg font-medium">{error ? 'It doesn’t play' : 'This browser can’t play it'}</p>
            <p className="max-w-md text-sm text-white/70">{error ?? answer?.notes.join(' ')}</p>
            <div className="flex gap-2">
              {error && (
                <Button variant="secondary" onClick={() => load(current, audio)}>
                  Try again
                </Button>
              )}
              <Button variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={back}>
                Go back
              </Button>
            </div>
          </div>
        )}

        {/* the top: back, what plays */}
        <div
          className={cn(
            'absolute inset-x-0 top-0 flex items-start gap-3 bg-linear-to-b from-black/80 via-black/40 to-transparent px-4 pt-4 pb-16 transition-opacity duration-300 md:px-6',
            chrome ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <Button variant="ghost" size="icon" aria-label="Back" title="Back (Esc)" className="shrink-0 text-white hover:bg-white/15 hover:text-white" onClick={back}>
            <ArrowLeft />
          </Button>
          <div className="min-w-0 flex-1 pt-1">
            <h1 className="truncate text-lg leading-tight font-semibold tracking-tight md:text-xl">{title?.title ?? item.title}</h1>
            <p className="truncate text-sm text-white/65">
              {title?.mediaType === 'tv' && title.season !== null
                ? item.title.startsWith(`${title.title} · `)
                  ? item.title.slice(`${title.title} · `.length)
                  : `Season ${title.season}, episode ${title.episode}`
                : title?.title && title.title !== item.title
                  ? item.title
                  : item.detail}
            </p>
          </div>
          {saving && (
            <span className="mt-1.5 hidden shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/85 sm:flex">
              <UserRound className="size-3.5" /> Saving for {profile!.name}
            </span>
          )}
        </div>

        {resumeAt !== null && current < resumeAt - 5 && !error && (
          <div className="absolute bottom-28 left-4 flex items-center gap-1 rounded-full bg-black/80 py-1.5 pr-1.5 pl-4 text-sm shadow-lg ring-1 ring-white/10 md:left-6">
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
            <button type="button" aria-label="Start from here" className="ml-1 rounded-full p-1 hover:bg-white/15" onClick={() => setResumeDismissed(true)}>
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {/* the bottom: the timeline and the controls */}
        <div
          className={cn(
            'absolute inset-x-0 bottom-0 space-y-2 bg-linear-to-t from-black/85 via-black/50 to-transparent px-4 pt-16 pb-4 transition-opacity duration-300 md:px-6',
            chrome ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          {/* what is downloaded (a torrent's file), what the browser holds, the position */}
          <div
            className="group/bar relative h-5 cursor-pointer touch-none"
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
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/20 transition-[height] group-hover/bar:h-1.5">
              {!whole &&
                downloaded.map(([a, b], i) => (
                  <span key={`d${i}`} className="absolute inset-y-0 bg-down/60" style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} />
                ))}
              {buffered.map(([a, b], i) => (
                <span
                  key={i}
                  className="absolute inset-y-0 bg-white/35"
                  style={{ left: `${fraction(offset + a) * 100}%`, width: `${(fraction(offset + b) - fraction(offset + a)) * 100}%` }}
                />
              ))}
              <span className="absolute inset-y-0 left-0 bg-gold" style={{ width: `${fraction(offset + time) * 100}%` }} />
            </div>
            <span
              className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold opacity-0 shadow transition-opacity group-hover/bar:opacity-100"
              style={{ left: `${fraction(offset + time) * 100}%` }}
            />
            {hoverAt !== null && duration ? (
              <span
                className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-black/85 px-1.5 py-0.5 text-xs tabular-nums ring-1 ring-white/10"
                style={{ left: `${fraction(hoverAt) * 100}%` }}
              >
                {clock(hoverAt)}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-1 [&_button]:text-white [&_button:hover]:bg-white/15 [&_button:hover]:text-white">
            <Button variant="ghost" size="icon" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={togglePlay}>
              {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
            </Button>
            <Button variant="ghost" size="icon" aria-label="Back 10 seconds" title="Back 10 s (←)" className="hidden sm:inline-flex" onClick={() => seek(position() - 10)}>
              <RotateCcw />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Forward 10 seconds" title="Forward 10 s (→)" className="hidden sm:inline-flex" onClick={() => seek(position() + 10)}>
              <RotateCw />
            </Button>
            <Button
              variant="ghost"
              size="icon"
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
              className="hidden h-1 w-20 accent-primary sm:block"
            />
            <span className="ml-2 text-sm text-white/85 tabular-nums">
              {clock(current)} <span className="text-white/50">/ {clock(duration)}</span>
            </span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Subtitles"
              aria-pressed={panel}
              title="Subtitles (S)"
              className={cn(subtitle !== 'off' && 'text-gold! hover:text-gold!')}
              onClick={() => setPanel((p) => !p)}
            >
              <Captions />
            </Button>
            <DropdownMenu onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Sound, speed and who’s watching" title="Sound, speed and who’s watching">
                  <Settings2 />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="max-h-[70svh] w-72 overflow-y-auto">
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
                            .join(', ')}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuLabel>Watch as</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={profile ? profile.id : 'none'}
                  onValueChange={(v) => {
                    const id = v === 'none' ? null : v
                    saveProgress.current()
                    setWatchAs(id)
                    store(WATCH_KEY, id)
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
              <Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label="Picture in picture" title="Picture in picture" onClick={pip}>
                <PictureInPicture2 />
              </Button>
            )}
            <Button variant="ghost" size="icon" aria-label={full ? 'Leave full screen' : 'Full screen'} title="Full screen (F)" onClick={fullscreen}>
              {full ? <Minimize /> : <Maximize />}
            </Button>
          </div>
        </div>
      </div>

      {panel && (
        <SubtitlePanel
          className="absolute inset-y-0 right-0 z-10 border-l shadow-2xl sm:w-96 lg:static lg:shadow-none"
          title={title}
          fileId={answer?.fileId ?? null}
          choices={choices}
          selected={subtitle}
          onSelect={chooseSubtitle}
          onAdd={(c) => {
            setAdded((a) => [...a, c])
            setSubtitle(c.id)
          }}
          delay={delay}
          onDelay={(d) => setDelay(Math.round(d * 100) / 100)}
          size={size}
          onSize={chooseSize}
          place={item.place}
          dir={item.dir}
          onClose={() => setPanel(false)}
        />
      )}
    </div>
  )
}
