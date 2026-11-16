import { useEffect, useRef } from 'react'
import HlsJs from 'hls.js'
import type { PlayerEvents, PlayerInfo, PlayerPort, PlayerTrack } from '../core/player/port'
import { Emitter } from '../core/util/emitter'
import { browserCapabilities, browserDeviceId } from '../web/browser'

// The player in a browser (docs/mobile-web-plan.md): an HTML5 <video>, with
// hls.js where the server streams HLS, as the same PlayerPort libmpv is on a
// phone (native/mpvPlayer.tsx). A browser doesn't decode every file, so a
// file asks the server how this browser plays it (GET /media/{ref}/playback,
// as the dashboard's player): direct, or an HLS stream the server makes
// (video copied, audio to AAC) that starts at `start` seconds of the file;
// a seek outside it, or another sound track, asks again. Credentials are the
// page's device cookie (same origin): no headers to add.
//
// Track ids follow mpv's (per kind, from 1): audio n+1 is the file's n-th
// sound (?audio=n), subtitle n+1 its n-th subtitle stream (WebVTT from
// …/subtitles/embedded/{n}); subtitles added from outside count from 1000. Every
// subtitle is drawn from its parsed cues on one text track, moved by the
// stream's start and `sub-delay`.

type Answer = { method: 'direct' | 'hls' | 'none'; url: string | null; start: number; duration: number | null; audio: number; notes: string[] }
type Cue = { start: number; end: number; text: string }
type Subtitle = { id: number; title: string; language: string; external: boolean; url: string; cues: Cue[] | null }

const EXTERNAL_BASE = 1000

function caps(): Record<string, string> {
  const c = browserCapabilities()
  const on = (yes: boolean) => (yes ? '1' : '0')
  return { mkv: on(c.containers.includes('mkv')), hevc: on(c.video.includes('hevc')), ac3: on(c.audio.includes('ac3')), eac3: on(c.audio.includes('eac3')) }
}

function withDevice(url: string): string {
  return url.includes('device=') ? url : `${url}${url.includes('?') ? '&' : '?'}device=${browserDeviceId()}`
}

/** WebVTT (the server's subtitles) as cues, in the file's time */
function parseVtt(text: string): Cue[] {
  const time = (t: string) => {
    const parts = t.trim().replace(',', '.').split(':').map(Number)
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
  }
  const cues: Cue[] = []
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const at = lines.findIndex((l) => l.includes('-->'))
    if (at < 0) continue
    const [from, rest] = lines[at].split('-->')
    const to = rest.trim().split(/\s+/)[0]
    const body = lines.slice(at + 1).join('\n').trim()
    if (body) cues.push({ start: time(from), end: time(to), text: body })
  }
  return cues
}

export class MpvPlayer implements PlayerPort {
  readonly events = new Emitter<PlayerEvents>()
  private video: HTMLVideoElement | null = null
  private hls: HlsJs | null = null
  /** <api>/media/{ref} of a file asked of /playback; null for a stream played as it is (a plugin's HLS) */
  private mediaUri: string | null = null
  private streamUri = ''
  private answer: Answer | null = null
  /** The file's time at the video's 0 (an HLS stream the server started at `start`) */
  private offset = 0
  private audioIndex = 0
  private pendingSeek: number | null = null
  private wantPlay = true
  private speed = 1
  private loadToken = 0
  private audioTracks: PlayerTrack[] = []
  private subtitles: Subtitle[] = []
  private shownSubtitle: number | null = null
  private subDelay = 0
  private subScale = 1
  private cueTrack: TextTrack | null = null
  private externalCount = 0
  private status: 'loading' | 'playing' | 'paused' | 'buffering' = 'loading'

  /** The <video>, from <MpvSurface> (null when it unmounts) */
  attach(video: HTMLVideoElement | null): void {
    if (video === this.video) return
    this.detach()
    this.video = video
    if (!video) return
    const on = (name: string, fn: () => void) => video.addEventListener(name, fn)
    on('loadedmetadata', () => {
      if (this.pendingSeek != null) {
        video.currentTime = Math.max(0, this.pendingSeek - this.offset)
        this.pendingSeek = null
      }
      video.playbackRate = this.speed
      this.events.emit('loaded', { duration: this.duration() })
      this.cueTrack = null
      this.drawSubtitles()
    })
    on('playing', () => this.setStatus('playing'))
    on('pause', () => this.setStatus('paused'))
    on('waiting', () => this.setStatus('buffering'))
    on('seeking', () => this.setStatus('buffering'))
    on('seeked', () => this.setStatus(video.paused ? 'paused' : 'playing'))
    on('timeupdate', () => this.progress())
    on('progress', () => this.progress())
    on('ended', () => {
      // A stream the server makes ends with its playlist; the file may be longer (it is still downloading)
      this.events.emit('ended', { reason: 'ended' })
    })
    on('error', () => {
      const code = video.error?.code
      if (!code || this.hls) return
      this.events.emit('error', { message: code === 4 ? 'This browser can’t play this file.' : 'The video stopped with an error.' })
    })
    if (this.streamUri) void this.open(this.pendingSeek ?? 0)
  }

  private detach(): void {
    this.hls?.destroy()
    this.hls = null
    if (this.video) {
      this.video.pause()
      this.video.removeAttribute('src')
      this.video.load()
    }
  }

  load(stream: { uri: string; headers: string[] }, startAt: number): void {
    this.streamUri = stream.uri
    this.mediaUri = /\/index\.m3u8($|\?)/.test(stream.uri) ? null : stream.uri
    this.audioIndex = 0
    this.subtitles = []
    this.shownSubtitle = null
    this.audioTracks = []
    this.wantPlay = true
    this.setStatus('loading')
    if (this.mediaUri) void this.loadTracks(this.mediaUri)
    if (this.video) void this.open(startAt)
    else this.pendingSeek = startAt
  }

  /** The file's own sound and subtitle streams (GET /media/{ref}/tracks) */
  private async loadTracks(uri: string): Promise<void> {
    const tracks = await fetch(withDevice(uri + '/tracks'), { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    if (!tracks || uri !== this.mediaUri) return
    type T = { source?: string; index?: number; language?: string | null; languageName?: string | null; title?: string | null; codec?: string | null; channels?: number | null; play?: string; available?: boolean }
    const embedded = (list: T[]) => (list ?? []).filter((t) => t.source === 'embedded' && t.index != null)
    this.audioTracks = embedded(tracks.audio).map((t) => ({
      id: (t.index as number) + 1,
      kind: 'audio' as const,
      title: [t.languageName, t.title].filter(Boolean).join(', '),
      language: t.language ?? '',
      codec: t.codec ?? '',
      selected: t.index === this.audioIndex,
      external: false,
      channels: t.channels ?? undefined,
    }))
    const text = embedded(tracks.subtitles).filter((t) => t.available !== false && (t.play === 'text' || t.play === 'convert' || t.play === undefined))
    const keep = this.subtitles.filter((s) => s.external)
    this.subtitles = [
      ...text.map((t) => ({
        id: (t.index as number) + 1,
        title: [t.languageName, t.title].filter(Boolean).join(', '),
        language: t.language ?? '',
        external: false,
        url: withDevice(`${uri}/subtitles/embedded/${t.index}`),
        cues: null,
      })),
      ...keep,
    ]
  }

  /** Plays the stream from `at` seconds of the file: asks /playback for a file first */
  private async open(at: number): Promise<void> {
    const video = this.video
    if (!video || !this.streamUri) return
    const token = ++this.loadToken
    this.hls?.destroy()
    this.hls = null
    let url = this.streamUri
    let viaHls = !this.mediaUri
    this.offset = 0
    if (this.mediaUri) {
      const query = new URLSearchParams({ ...caps(), device: browserDeviceId(), t: String(Math.max(0, Math.floor(at))), audio: String(this.audioIndex) })
      let answer: Answer
      try {
        const res = await fetch(`${this.mediaUri}/playback?${query}`, { credentials: 'same-origin' })
        answer = await res.json()
        if (!res.ok) throw new Error((answer as unknown as { error?: string }).error ?? `The server answered ${res.status}`)
      } catch (e) {
        if (token === this.loadToken) this.events.emit('error', { message: e instanceof Error ? e.message : 'The server didn’t answer.' })
        return
      }
      if (token !== this.loadToken) return
      this.answer = answer
      if (answer.method === 'none' || !answer.url) {
        this.events.emit('error', { message: answer.notes?.join(' ') || 'This browser can’t play this file.' })
        return
      }
      // `url` is under the API prefix
      const api = this.mediaUri.slice(0, this.mediaUri.indexOf('/media/'))
      url = /^https?:/.test(answer.url) ? answer.url : api + answer.url.replace(/^\/api\/v\d+/, '')
      viaHls = answer.method === 'hls'
      this.offset = viaHls ? answer.start : 0
    }
    url = withDevice(url)
    this.pendingSeek = viaHls ? (at > this.offset + 1 ? at : null) : at
    this.setStatus('loading')
    // hls.js wherever MediaSource is (Chrome says it plays HLS itself, and fails on these streams);
    // the browser's own player only without it (Safari on iPhone)
    if (viaHls && HlsJs.isSupported()) {
      const hls = new HlsJs({
        lowLatencyMode: false,
        xhrSetup: (xhr) => {
          xhr.withCredentials = true
        },
      })
      hls.on(HlsJs.Events.ERROR, (_e, data) => {
        if (data.fatal) this.events.emit('error', { message: data.details === 'manifestLoadError' ? 'The server couldn’t start the stream.' : `Playback stopped (${data.details}).` })
      })
      hls.loadSource(url)
      hls.attachMedia(video)
      this.hls = hls
    } else {
      video.src = url
    }
    if (this.wantPlay) video.play().catch(() => this.setStatus('paused'))
  }

  private duration(): number {
    if (this.answer?.duration) return this.answer.duration
    const d = this.video?.duration
    return d && Number.isFinite(d) ? d + this.offset : 0
  }

  private position(): number {
    return this.offset + (this.video?.currentTime ?? 0)
  }

  private progress(): void {
    const video = this.video
    if (!video) return
    const now = video.currentTime
    let bufferedTo = 0
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= now + 0.5 && video.buffered.end(i) >= now) bufferedTo = video.buffered.end(i)
    }
    const position = this.offset + now
    this.events.emit('progress', {
      position,
      duration: this.duration(),
      bufferedTo: bufferedTo ? bufferedTo + this.offset : 0,
      cacheAhead: bufferedTo ? Math.max(0, bufferedTo - now) : 0,
      networkRate: 0,
    })
  }

  private setStatus(status: MpvPlayer['status']): void {
    this.status = status
    this.events.emit('status', status)
  }

  play(): void {
    this.wantPlay = true
    void this.video?.play().catch(() => {})
  }

  pause(): void {
    this.wantPlay = false
    this.video?.pause()
  }

  seekTo(seconds: number): void {
    const video = this.video
    if (!video) return
    const target = Math.max(0, seconds)
    if (this.answer?.method === 'hls' && this.mediaUri) {
      // Inside the stream the server makes (what it made so far): the video seeks; else a new stream from there
      const end = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0
      if (target >= this.offset && target - this.offset <= end) video.currentTime = target - this.offset
      else void this.open(target)
      return
    }
    video.currentTime = target
  }

  setSpeed(speed: number): void {
    this.speed = speed
    if (this.video) this.video.playbackRate = speed
  }

  async tracks(): Promise<PlayerTrack[]> {
    const audio = this.audioTracks.map((t) => ({ ...t, selected: t.id === this.audioIndex + 1 }))
    const subs: PlayerTrack[] = this.subtitles.map((s) => ({
      id: s.id,
      kind: 'subtitle',
      title: s.title,
      language: s.language,
      codec: 'webvtt',
      selected: s.id === this.shownSubtitle,
      external: s.external,
    }))
    return [...audio, ...subs]
  }

  selectAudio(id: number): void {
    if (id >= EXTERNAL_BASE || id - 1 === this.audioIndex) return
    this.audioIndex = id - 1
    // Another sound: the server's stream with it (or the file, when the browser plays that one), from here
    if (this.mediaUri) void this.open(this.position())
  }

  selectSubtitle(id: number | null): void {
    this.shownSubtitle = id
    const sub = this.subtitles.find((s) => s.id === id)
    if (sub && !sub.cues) void this.fetchCues(sub)
    this.drawSubtitles()
  }

  private async fetchCues(sub: Subtitle): Promise<void> {
    const text = await fetch(sub.url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => '')
    sub.cues = parseVtt(text)
    this.drawSubtitles()
  }

  addSubtitle(url: string, title?: string, language?: string): void {
    const sameOrigin = url.startsWith(window.location.origin)
    const sub: Subtitle = { id: EXTERNAL_BASE + ++this.externalCount, title: title ?? 'Subtitles', language: language ?? '', external: true, url: sameOrigin ? withDevice(url) : url, cues: null }
    this.subtitles.push(sub)
    this.selectSubtitle(sub.id)
  }

  addAudio(): void {
    // A separate sound file can't be played beside the video here: the phone app's player can
    this.events.emit('error', { message: 'A separate sound file plays only in the Playpex app.' })
  }

  setProperty(name: string, value: string): void {
    if (name === 'sub-delay') {
      this.subDelay = Number(value) || 0
      this.drawSubtitles()
    } else if (name === 'sub-scale') {
      this.subScale = Number(value) || 1
      cueStyle(this.subScale)
    } else if (name === 'speed') {
      this.setSpeed(Number(value) || 1)
    }
    // mpv's other properties (styles, pan and scan, brightness) have no browser counterpart
  }

  /** The shown subtitle's cues on the video's own text track, in the video's time */
  private drawSubtitles(): void {
    const video = this.video
    if (!video) return
    if (!this.cueTrack) {
      for (let i = 0; i < video.textTracks.length; i++) video.textTracks[i].mode = 'disabled'
      this.cueTrack = video.addTextTrack('subtitles', 'Playpex', '')
    }
    const track = this.cueTrack
    track.mode = 'hidden'
    while (track.cues && track.cues.length) track.removeCue(track.cues[0])
    const sub = this.subtitles.find((s) => s.id === this.shownSubtitle)
    if (!sub?.cues) return
    const shift = this.subDelay - this.offset
    for (const c of sub.cues) {
      const start = c.start + shift
      const end = c.end + shift
      if (end > 0) track.addCue(new VTTCue(Math.max(0, start), end, c.text))
    }
    track.mode = 'showing'
  }

  async info(): Promise<PlayerInfo> {
    const video = this.video
    return {
      decoder: 'hardware',
      videoCodec: this.answer?.method === 'hls' ? 'h264 (server stream)' : '',
      audioCodec: this.answer?.method === 'hls' ? 'aac (server stream)' : '',
      width: video?.videoWidth ?? 0,
      height: video?.videoHeight ?? 0,
      fps: 0,
      videoBitrate: 0,
      audioBitrate: 0,
      hdr: false,
    }
  }
}

/** Subtitle size (mpv's sub-scale), for every cue */
function cueStyle(scale: number): void {
  let style = document.getElementById('playpex-cue-style')
  if (!style) {
    style = document.createElement('style')
    style.id = 'playpex-cue-style'
    document.head.appendChild(style)
  }
  style.textContent = `video::cue { font-size: ${Math.round(scale * 100)}%; background: rgba(0, 0, 0, 0.55); }`
}

/** The video itself: full size, black around the picture */
export function MpvSurface({ player }: { player: MpvPlayer }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    cueStyle(1)
    player.attach(ref.current)
    return () => player.attach(null)
  }, [player])
  return (
    <video
      ref={ref}
      playsInline
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', backgroundColor: 'black' }}
    />
  )
}
