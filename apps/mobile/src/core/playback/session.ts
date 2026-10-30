import { ApiError } from '../http/api'
import type { ApiClient } from '../http/client'
import {
  addTorrent,
  fileIdOf,
  getTorrent,
  keepalive,
  label,
  release,
  saveProgress,
  torrentStats,
  type PlaySource,
  type PlayTitle,
  type TorrentFile,
  type TorrentStats,
} from '../services/playback'
import { Disposer } from '../util/disposer'
import { Store } from '../util/store'

// One playback: from the source chosen to the player closing
// (docs/api/playback.md). It owns everything the server needs from a player:
//
//   preparing ──► ready ──► (playing, reported by the player) ──► stop()
//       │           │ switchFile(): another video of the same torrent, same lease
//       ▼           ▼
//     failed ◄── keepalive 404 (the server no longer has it)
//
//   - the lease: taken by the first request, kept with a keepalive every 60 s
//     (paused or not), released in stop() whatever happened, also before a file was known
//   - a torrent: added, its file waited for (the server's `chosen`), peers shown meanwhile;
//     its downloaded parts polled every 5 s for the timeline
//   - the profile's progress: every 15 s while playing, on pause, and in stop(); never
//     before playback really started, never for live streams
//
// The player screen reports what the player does (report(), started()); it never
// calls the server itself.

export const KEEPALIVE_MS = 60_000
export const PROGRESS_MS = 15_000
export const TORRENT_POLL_MS = 5000
const METADATA_POLL_MS = 3000
const METADATA_TIMEOUT_MS = 90_000

export type Stream = {
  /** The URL the player opens, with `headers` (`Name: value`: mpv sends them with every request, HLS parts too) */
  uri: string
  headers: string[]
  format: 'file' | 'hls' | 'live'
  live: boolean
}

/** The file playing */
export type Target = {
  ref: string
  infoHash: string | null
  /** A torrent's path of the file */
  filePath: string | null
  /** A library file's id */
  fileId: string | null
  name: string | null
  size: number | null
}

export type SessionPhase =
  | { phase: 'preparing'; message: string; stats: TorrentStats | null }
  | { phase: 'ready'; target: Target; stream: Stream }
  | { phase: 'failed'; message: string }

export type SessionState = {
  status: SessionPhase
  /** A torrent's progress runs (percent of pieces, alternating downloaded / missing), for the timeline */
  downloaded: number[] | null
  /** A torrent's files (its other videos: episodes of a pack, extras) */
  files: TorrentFile[] | null
}

export type PlaybackOptions = {
  client: ApiClient
  profileId: string
  title: PlayTitle
  source: PlaySource
  /** Seconds to start at (a resume point of this release) */
  startAt: number
  /** Saves nothing for this playback (a plugin's `tracking: 'none'`) */
  tracking?: 'full' | 'none'
  /** The tracks the profile chose last time (MediaTracks ids) */
  tracks?: { audio: string | null; subtitle: string | null }
}

type Report = { position: number; duration: number; paused: boolean }

export class PlaybackSession {
  readonly state = new Store<SessionState>({ status: { phase: 'preparing', message: 'Starting…', stats: null }, downloaded: null, files: null })
  readonly title: PlayTitle
  readonly source: PlaySource
  startAt: number
  private readonly client: ApiClient
  private readonly profileId: string
  private readonly tracking: 'full' | 'none'
  private run: Disposer | null = null
  private lease: { ref: string | null; infoHash: string | null } = { ref: null, infoHash: null }
  private last: Report = { position: 0, duration: 0, paused: false }
  private playing = false
  private tracks: { audio: string | null; subtitle: string | null }
  private readonly initialTracks: { audio: string | null; subtitle: string | null }

  constructor(options: PlaybackOptions) {
    this.client = options.client
    this.profileId = options.profileId
    this.title = options.title
    this.source = options.source
    this.startAt = options.startAt
    this.tracking = options.tracking ?? 'full'
    this.tracks = options.tracks ?? { audio: null, subtitle: null }
    this.initialTracks = this.tracks
  }

  /** Gets the source ready and keeps the lease; again after stop() (a remount) */
  start(): void {
    if (this.run && !this.run.disposed) return
    const run = (this.run = new Disposer())
    this.playing = false
    this.state.patch({ status: { phase: 'preparing', message: 'Starting…', stats: null } })
    void this.prepare(run)
    run.interval(KEEPALIVE_MS, () => void this.beat())
    run.interval(PROGRESS_MS, () => {
      if (!this.last.paused) void this.save()
    })
  }

  /** The player closes: the last position, then the lease goes back (once) */
  stop(): void {
    if (!this.run || this.run.disposed) return
    this.run.dispose()
    void this.save()
    void release(this.client, this.lease)
  }

  /** Try again after a failure */
  retry(): void {
    this.stop()
    this.start()
  }

  /** What the player does, as it plays (position, length, paused) */
  report(report: Report): void {
    const pausedNow = report.paused && !this.last.paused
    this.last = report
    if (!this.playing && report.position > 0) this.playing = true
    if (pausedNow) void this.save()
  }

  /** The tracks chosen in the player, saved with the progress */
  chooseTracks(tracks: Partial<{ audio: string | null; subtitle: string | null }>): void {
    this.tracks = { ...this.tracks, ...tracks }
  }

  /** The tracks the profile chose for this release last time (MediaTracks ids), for the player to restore */
  get savedTracks(): { audio: string | null; subtitle: string | null } {
    return this.initialTracks
  }

  /** A URL of a media ref for the player (it sends the server's headers itself) */
  mediaUrl(ref: string, suffix = ''): string {
    return this.client.mediaUrl(ref, suffix)
  }

  /** Another video of the same torrent from the server's track list (MediaTracks.video) */
  switchVideo(video: { ref?: string; name?: string; size?: number | null }): void {
    if (!video.ref || !video.name) return
    this.switchFile({ ref: video.ref, path: video.name, name: video.name.split('/').pop() ?? video.name, length: video.size ?? 0 } as TorrentFile)
  }

  /** Another video of the same torrent (an episode of a pack, an extra): the lease stays */
  switchFile(file: TorrentFile): void {
    const status = this.state.get().status
    if (status.phase !== 'ready' || !status.target.infoHash) return
    void this.save()
    const target: Target = { ref: file.ref, infoHash: status.target.infoHash, filePath: file.path, fileId: null, name: file.name, size: file.length }
    this.lease = { ref: file.ref, infoHash: status.target.infoHash }
    this.playing = false
    this.last = { position: 0, duration: 0, paused: false }
    this.startAt = 0
    this.tracks = { audio: null, subtitle: null }
    this.state.patch({ status: { phase: 'ready', target, stream: this.streamOf(target) } })
  }

  /** What is watched is saved for the profile (not a plugin's `tracking: 'none'`) */
  get tracked(): boolean {
    return this.tracking !== 'none'
  }

  get label(): string {
    return label(this.title)
  }

  private async prepare(run: Disposer): Promise<void> {
    try {
      const target = await this.resolve(run)
      if (run.disposed || !target) return
      this.lease = { ref: target.ref, infoHash: target.infoHash }
      this.state.patch({ status: { phase: 'ready', target, stream: this.streamOf(target) } })
      if (target.infoHash) run.interval(TORRENT_POLL_MS, () => void this.pollTorrent(run, target.infoHash!))
    } catch (e) {
      if (run.disposed) return
      const message = e instanceof ApiError && e.code === 'BUSY' ? e.message || 'The server is busy: it already plays as much as it allows.' : e instanceof Error ? e.message : String(e)
      this.state.patch({ status: { phase: 'failed', message } })
    }
  }

  /** The file to play: a ref at once; a torrent's once its file list is known */
  private async resolve(run: Disposer): Promise<Target | null> {
    const source = this.source
    if (source.ref) {
      this.lease = { ref: source.ref, infoHash: source.infoHash ?? null }
      return { ref: source.ref, infoHash: source.infoHash ?? null, filePath: source.path ?? null, fileId: fileIdOf(source.ref), name: source.label, size: source.size ?? null }
    }
    const link = source.magnet ?? source.infoHash
    if (!link) throw new Error('This source has nothing to play.')
    this.state.patch({ status: { phase: 'preparing', message: 'Adding the torrent…', stats: null } })
    const infoHash = await addTorrent(this.client, link)
    this.lease = { ref: null, infoHash }
    if (run.disposed) return null
    const until = Date.now() + METADATA_TIMEOUT_MS
    for (;;) {
      const torrent = await getTorrent(this.client, infoHash, this.title, source.file ?? undefined)
      if (run.disposed) return null
      if (torrent.files?.length && torrent.chosen !== undefined) {
        const file = torrent.files.find((f) => f.path === torrent.chosen)
        if (!file) throw new Error('No video of this torrent fits. Try another source.')
        this.state.patch({ files: torrent.files, downloaded: torrent.progress ?? null })
        return { ref: file.ref, infoHash, filePath: file.path, fileId: null, name: file.name, size: file.length }
      }
      if (Date.now() > until) throw new Error('No one is sharing this torrent right now. Try another source.')
      const stats = await torrentStats(this.client, infoHash).catch(() => null)
      if (run.disposed) return null
      const peers = stats?.peers?.total ?? 0
      this.state.patch({ status: { phase: 'preparing', message: peers ? `Connecting to ${peers} peers…` : 'Looking for peers…', stats } })
      await run.sleep(METADATA_POLL_MS)
      if (run.disposed) return null
    }
  }

  private streamOf(target: Target): Stream {
    const format = this.source.format === 'hls' || this.source.format === 'live' ? this.source.format : 'file'
    // No /playback: the phone decodes every format itself, so the file plays as it is
    const uri = format === 'hls' ? this.client.mediaUrl(target.ref, '/index.m3u8') : this.client.mediaUrl(target.ref)
    return { uri, headers: this.client.headerLines(), format, live: format === 'live' }
  }

  private async beat(): Promise<void> {
    const status = this.state.get().status
    if (status.phase !== 'ready') return
    const t = this.title
    const { response } = await keepalive(this.client, status.target.ref, {
      positionS: Math.floor(this.last.position),
      durationS: this.last.duration ? Math.floor(this.last.duration) : undefined,
      paused: this.last.paused,
      title: label(t),
      profileId: this.tracking === 'none' ? undefined : this.profileId,
      file: status.target.filePath ?? undefined,
      ...(this.tracking === 'none' ? {} : { media: { mediaType: t.mediaType, tmdbId: t.tmdbId, ...(t.mediaType === 'tv' ? { season: t.season, episode: t.episode } : {}) } }),
    }).catch(() => ({ response: null }))
    if (response?.status === 404) this.state.patch({ status: { phase: 'failed', message: 'The server no longer has this file.' } })
  }

  private async pollTorrent(run: Disposer, infoHash: string): Promise<void> {
    const torrent = await getTorrent(this.client, infoHash, this.title).catch(() => null)
    if (run.disposed || !torrent) return
    this.state.patch({ downloaded: torrent.progress ?? null, files: torrent.files ?? this.state.get().files })
  }

  private async save(): Promise<void> {
    const status = this.state.get().status
    const { position, duration } = this.last
    if (this.tracking === 'none' || !this.playing || status.phase !== 'ready' || status.stream.live || !duration) return
    const { target } = status
    await saveProgress(this.client, this.profileId, this.title, {
      positionS: Math.floor(position),
      durationS: Math.floor(duration),
      infoHash: target.fileId ? null : target.infoHash,
      filePath: target.fileId ? null : target.filePath,
      fileId: target.fileId,
      audioTrack: this.tracks.audio,
      subtitleTrack: this.tracks.subtitle,
    })
  }
}
