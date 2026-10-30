import type { PlaybackSession, Stream } from '../playback/session'
import type { MediaTrack, MediaTracks } from '../services/playback'
import { SUBTITLE_SCALE, playerProperties, type PlayerPreferences } from './preferences'
import { Disposer } from '../util/disposer'
import { Emitter } from '../util/emitter'
import { Store } from '../util/store'
import type { PlayerPort, PlayerStatus, PlayerTrack } from './port'

// The player screen's state: what the video does, the controls, the scrub and
// the double-tap skip. It loads the session's stream into the player when it is
// ready (and again after a file switch), reports the player's progress to the
// session, and tells the screen when the video has finished. The screen draws
// this and calls its methods; it touches neither the player nor the server.

export const CONTROLS_HIDE_MS = 4000
export const SKIP_STEP_S = 10
/** Two taps closer than this are a double tap */
export const DOUBLE_TAP_MS = 250
// Long enough for a further single tap, which waits out the double-tap window before it counts
export const SKIP_SETTLE_MS = 700

export type PlayerUiState = {
  status: PlayerStatus
  position: number
  duration: number
  bufferedTo: number
  controls: boolean
  /** Seconds the scrubber points at while dragged; null otherwise */
  scrub: number | null
  /** A double-tap skip being gathered: -20 = twenty seconds back */
  skip: number | null
  tracks: PlayerTrack[]
  /** The server's list for the file: a torrent's separate audio / subtitle files, its other videos (null until known) */
  files: MediaTracks | null
  /** An online subtitle shown (its name), added to the player's tracks */
  online: string | null
  tuning: Tuning
  error: string | null
}

/** What the viewer adjusts while watching (mpv properties; nothing of it is saved) */
export type Tuning = {
  speed: number
  /** Seconds, positive = later */
  subtitleDelay: number
  audioDelay: number
  /** mpv sub-scale */
  subtitleScale: number
  /** mpv sub-pos: 100 = the bottom, less = higher */
  subtitlePosition: number
  subtitleBackground: boolean
  picture: Picture
  /** mpv brightness, -50…50 */
  brightness: number
}

export type Picture = 'fit' | 'fill' | 'stretch'

export const PICTURES: { key: Picture; label: string; help: string }[] = [
  { key: 'fit', label: 'Fit', help: 'The whole picture, with black bars where its shape differs from the screen’s.' },
  { key: 'fill', label: 'Fill', help: 'The screen filled: the picture’s edges are cut off.' },
  { key: 'stretch', label: 'Stretch', help: 'The screen filled: the picture is stretched to its shape.' },
]

export const DEFAULT_TUNING: Tuning = { speed: 1, subtitleDelay: 0, audioDelay: 0, subtitleScale: 1, subtitlePosition: 100, subtitleBackground: false, picture: 'fit', brightness: 0 }

type Events = { finished: void }

export class PlayerController {
  readonly state = new Store<PlayerUiState>({
    status: 'loading',
    position: 0,
    duration: 0,
    bufferedTo: 0,
    controls: true,
    scrub: null,
    skip: null,
    tracks: [],
    files: null,
    online: null,
    tuning: DEFAULT_TUNING,
    error: null,
  })
  readonly events = new Emitter<Events>()
  private run: Disposer | null = null
  private loadedStream: Stream | null = null
  private hideTimer: (() => void) | null = null
  private skipTimer: (() => void) | null = null
  /** A first tap waiting to see whether a second one follows */
  private pendingTap: { side: -1 | 0 | 1; at: number; cancel: (() => void) | null } | null = null

  constructor(
    readonly session: PlaybackSession,
    private readonly player: PlayerPort,
    /** Called once each time the controller stops (the screen leaves): what the profile watched changed */
    private readonly onClose: () => void = () => {},
    /** The settings' tracks and subtitle size (core/player/preferences.ts), applied before the first file opens */
    private readonly preferences: (() => Promise<PlayerPreferences | null>) | null = null,
    /** The server's tracks of a file (GET /media/{ref}/tracks) */
    private readonly serverTracks: ((ref: string) => Promise<MediaTracks>) | null = null,
  ) {}
  private preferred: Promise<void> | null = null
  /** The resume point's tracks wait for the first file to open, then apply once */
  private savedTracksPending = true

  start(): void {
    if (this.run && !this.run.disposed) return
    const run = (this.run = new Disposer())
    this.session.start()
    run.add(() => this.session.stop())
    run.add(this.session.state.subscribe(() => this.follow()))
    this.follow()
    const { events } = this.player
    run.add(events.on('progress', (p) => this.onProgress(p.position, p.duration, p.bufferedTo)))
    run.add(events.on('status', (status) => this.onStatus(status)))
    run.add(events.on('loaded', ({ duration }) => this.onLoaded(duration)))
    run.add(events.on('error', ({ message }) => this.state.patch({ error: message })))
    run.add(
      events.on('ended', ({ reason }) => {
        if (reason === 'ended') this.events.emit('finished', undefined)
      }),
    )
    this.showControls()
  }

  stop(): void {
    if (!this.run || this.run.disposed) return
    this.run.dispose()
    this.loadedStream = null
    this.onClose()
  }

  togglePlay(): void {
    if (this.state.get().status === 'paused') this.player.play()
    else this.player.pause()
    this.showControls()
  }

  /** From the start again, after the end */
  replay(): void {
    this.seekTo(0)
    this.player.play()
  }

  /** A tap on the video: the controls come or go */
  toggleControls(): void {
    if (this.state.get().controls) this.hideControls()
    else this.showControls()
  }

  /** The controls, hidden again after a while unless paused */
  showControls(): void {
    this.state.patch({ controls: true })
    this.hideTimer?.()
    this.hideTimer = this.run?.timeout(CONTROLS_HIDE_MS, () => {
      if (this.state.get().status !== 'paused' && this.state.get().scrub == null) this.state.patch({ controls: false })
    }) ?? null
  }

  hideControls(): void {
    this.hideTimer?.()
    this.state.patch({ controls: false })
  }

  /**
   * A touch on the video, on its left (-1), middle (0) or right (1) third:
   * the second of two within DOUBLE_TAP_MS on one side is a double tap; a lone
   * one counts once the window has passed (while a skip gathers on its side,
   * at once). The screen calls this for every press: it times them here, so
   * the buttons drawn over the video keep their own touches.
   */
  press(side: -1 | 0 | 1, now = Date.now()): void {
    const first = this.pendingTap
    if (first && first.side === side && now - first.at < DOUBLE_TAP_MS) {
      first.cancel?.()
      this.pendingTap = null
      this.doubleTap(side)
      return
    }
    first?.cancel?.()
    this.pendingTap = null
    const gathering = this.state.get().skip
    if (side !== 0 && gathering != null && Math.sign(gathering) === side) return this.skip(side)
    const tap = { side, at: now, cancel: null as (() => void) | null }
    tap.cancel =
      this.run?.timeout(DOUBLE_TAP_MS, () => {
        if (this.pendingTap === tap) this.pendingTap = null
        this.tap(side)
      }) ?? null
    this.pendingTap = tap
  }

  /**
   * One tap on the video, on its left (-1), middle (0) or right (1) third: while a double-tap
   * skip gathers on that side it adds ten seconds more ("each further tap"); otherwise the
   * controls come or go.
   */
  tap(side: -1 | 0 | 1): void {
    const gathering = this.state.get().skip
    if (side !== 0 && gathering != null && Math.sign(gathering) === side) this.skip(side)
    else this.toggleControls()
  }

  /** Two taps: the left or right third skips, the middle plays or pauses */
  doubleTap(side: -1 | 0 | 1): void {
    if (side === 0) this.togglePlay()
    else this.skip(side)
  }

  /** A double tap: ten seconds more each time; the seek happens once the taps stop */
  skip(direction: -1 | 1): void {
    if (this.isLive()) return
    const current = this.state.get().skip
    const gathered = current != null && Math.sign(current) === direction ? current + direction * SKIP_STEP_S : direction * SKIP_STEP_S
    this.state.patch({ skip: gathered })
    this.skipTimer?.()
    this.skipTimer =
      this.run?.timeout(SKIP_SETTLE_MS, () => {
        const { position, skip } = this.state.get()
        this.state.patch({ skip: null })
        if (skip) this.seekTo(position + skip)
      }) ?? null
  }

  seekTo(seconds: number): void {
    if (this.isLive()) return
    const { duration } = this.state.get()
    const target = Math.max(0, duration ? Math.min(seconds, duration - 1) : seconds)
    this.player.seekTo(target)
    this.state.patch({ position: target })
    this.showControls()
  }

  /** Dragging the timeline: the time shown follows, the seek happens on release */
  scrubTo(seconds: number): void {
    this.state.patch({ scrub: seconds, controls: true })
    this.hideTimer?.()
  }

  endScrub(): void {
    const { scrub } = this.state.get()
    this.state.patch({ scrub: null })
    if (scrub != null) this.seekTo(scrub)
  }

  async refreshTracks(): Promise<void> {
    const tracks = await this.player.tracks()
    if (!this.run?.disposed) this.state.patch({ tracks })
  }

  selectAudio(track: PlayerTrack): void {
    this.player.selectAudio(track.id)
    if (!track.external) this.session.chooseTracks({ audio: `a:${track.id - 1}` })
    void this.refreshTracks()
  }

  selectSubtitle(track: PlayerTrack | null): void {
    this.player.selectSubtitle(track?.id ?? null)
    this.session.chooseTracks({ subtitle: track && !track.external ? `s:${track.id - 1}` : null })
    void this.refreshTracks()
  }

  /** A separate file of the torrent (an audio file, a subtitle file), or a library file's sidecar, added to the player */
  addFileTrack(track: MediaTrack, kind: 'audio' | 'subtitle'): void {
    const status = this.session.state.get().status
    if (status.phase !== 'ready') return
    const name = [track.languageName, track.title].filter(Boolean).join(', ') || track.name?.split('/').pop() || undefined
    if (kind === 'audio' && track.ref) this.player.addAudio(this.session.mediaUrl(track.ref), name, track.language ?? undefined)
    if (kind === 'subtitle') {
      // s:f3 → …/subtitles/file/f3 (WebVTT); a sidecar (its index) → …/subtitles/{index}
      const id = track.id.startsWith('s:') ? track.id.slice(2) : track.id
      const suffix = track.source === 'file' && id.startsWith('f') ? `/subtitles/file/${id}` : `/subtitles/${track.index ?? id}`
      this.player.addSubtitle(this.session.mediaUrl(status.target.ref, suffix), name, track.language ?? undefined)
      this.state.patch({ online: null })
    }
    this.session.chooseTracks(kind === 'audio' ? { audio: track.id } : { subtitle: track.id })
    this.refreshTracksSoon()
  }

  /** An online subtitle's file (core/player/subtitles.ts), shown at once */
  addOnlineSubtitle(file: { url: string; title: string; language: string }): void {
    this.player.addSubtitle(file.url, file.title, file.language)
    // Found online: it can't be found again later, so nothing is saved for it
    this.session.chooseTracks({ subtitle: null })
    this.state.patch({ online: file.title })
    this.refreshTracksSoon()
  }

  tune(change: Partial<Tuning>): void {
    const tuning = { ...this.state.get().tuning, ...change }
    this.state.patch({ tuning })
    if (change.speed != null) this.player.setSpeed(tuning.speed)
    for (const [name, value] of tuningProperties(change, tuning)) this.player.setProperty(name, value)
  }

  /** A track added from a URL shows in mpv's list once mpv has read it */
  private refreshTracksSoon(): void {
    void this.refreshTracks()
    this.run?.timeout(1500, () => void this.refreshTracks())
  }

  /** The tracks the profile chose for this release last time (a resume): `a:2` → mpv's audio 3 */
  private applySavedTracks(): void {
    if (!this.savedTracksPending) return
    this.savedTracksPending = false
    const saved = this.session.savedTracks
    const embedded = (id: string | null, kind: 'a' | 's') => {
      const m = id ? new RegExp(`^${kind}:(\\d+)$`).exec(id) : null
      return m ? Number(m[1]) + 1 : null
    }
    const audio = embedded(saved.audio, 'a')
    const subtitle = embedded(saved.subtitle, 's')
    if (audio != null) this.player.selectAudio(audio)
    if (subtitle != null) this.player.selectSubtitle(subtitle)
  }

  private isLive(): boolean {
    const status = this.session.state.get().status
    return status.phase === 'ready' && status.stream.live
  }

  /** The session's stream into the player, once per stream */
  private follow(): void {
    const status = this.session.state.get().status
    if (status.phase !== 'ready' || status.stream === this.loadedStream) return
    this.loadedStream = status.stream
    this.state.patch({ status: 'loading', position: this.session.startAt, duration: 0, bufferedTo: 0, tracks: [], files: null, online: null, error: null })
    const stream = status.stream
    const ref = status.target.ref
    if (this.serverTracks && !stream.live) {
      const run = this.run
      void this.serverTracks(ref)
        .then((files) => {
          if (run && !run.disposed && this.loadedStream === stream) this.state.patch({ files })
        })
        .catch(() => {})
    }
    const open = () => this.player.load(stream, stream.live ? 0 : this.session.startAt)
    if (!this.preferences) return open()
    const run = this.run
    this.preferred ??= this.preferences()
      .then((p) => {
        if (!p) return
        for (const [name, value] of playerProperties(p)) this.player.setProperty(name, value)
        // the size the settings ask for is where the viewer's adjustments start
        this.state.patch({ tuning: { ...this.state.get().tuning, subtitleScale: SUBTITLE_SCALE[p.subtitleSize] ?? 1 } })
      })
      .catch(() => {})
    void this.preferred.then(() => {
      if (run && !run.disposed && this.loadedStream === stream) open()
    })
  }

  private onProgress(position: number, duration: number, bufferedTo: number): void {
    const s = this.state.get()
    this.state.patch({ position: s.scrub != null ? s.position : position, duration: duration > 0 ? duration : s.duration, bufferedTo })
    this.session.report({ position, duration: duration > 0 ? duration : s.duration, paused: s.status === 'paused' })
  }

  private onStatus(status: PlayerStatus): void {
    this.state.patch({ status })
    const s = this.state.get()
    this.session.report({ position: s.position, duration: s.duration, paused: status === 'paused' })
    if (status === 'paused') this.showControls()
  }

  private onLoaded(duration: number): void {
    if (duration > 0) this.state.patch({ duration })
    this.applySavedTracks()
    // A new file starts with mpv's defaults: the viewer's adjustments again
    const { tuning } = this.state.get()
    if (tuning.speed !== 1) this.player.setSpeed(tuning.speed)
    const changed = Object.fromEntries(Object.entries(tuning).filter(([k, v]) => DEFAULT_TUNING[k as keyof Tuning] !== v)) as Partial<Tuning>
    for (const [name, value] of tuningProperties(changed, tuning)) this.player.setProperty(name, value)
    void this.refreshTracks()
  }
}

/** The mpv properties of the fields that changed */
export function tuningProperties(change: Partial<Tuning>, t: Tuning): [string, string][] {
  const out: [string, string][] = []
  if (change.subtitleDelay != null) out.push(['sub-delay', String(t.subtitleDelay)])
  if (change.audioDelay != null) out.push(['audio-delay', String(t.audioDelay)])
  if (change.subtitleScale != null) out.push(['sub-scale', String(t.subtitleScale)])
  if (change.subtitlePosition != null) out.push(['sub-pos', String(t.subtitlePosition)])
  if (change.subtitleBackground != null) {
    out.push(['sub-border-style', t.subtitleBackground ? 'background-box' : 'outline-and-shadow'], ['sub-back-color', t.subtitleBackground ? '#B3000000' : '#00000000'])
  }
  if (change.picture != null) {
    out.push(['panscan', t.picture === 'fill' ? '1.0' : '0.0'], ['keepaspect', t.picture === 'stretch' ? 'no' : 'yes'])
  }
  if (change.brightness != null) out.push(['brightness', String(t.brightness)])
  return out
}
