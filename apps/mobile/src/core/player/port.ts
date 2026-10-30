import type { Emitter } from '../util/emitter'

// The video player as the app sees it, whatever plays underneath (libmpv
// today: src/native/mpvPlayer.tsx). The player screen's controller talks to
// this and nothing else; tests give a fake.

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended'

export type PlayerProgress = {
  position: number
  duration: number
  /** Up to where the player has the file in memory (seconds), 0 when unknown */
  bufferedTo: number
  /** Seconds buffered ahead of the position */
  cacheAhead: number
  /** Bytes per second the player reads from the network, 0 when unknown */
  networkRate: number
}

export type PlayerTrack = {
  /** The player's id of the track (mpv: 1, 2… per kind) */
  id: number
  kind: 'video' | 'audio' | 'subtitle'
  title: string
  /** ISO 639 code, or '' */
  language: string
  codec: string
  selected: boolean
  /** Added from outside the file (a subtitle file, a torrent's audio file) */
  external: boolean
  channels?: number
}

export type PlayerInfo = {
  /** The decoder in use: the phone's hardware, or software (FFmpeg) */
  decoder: 'hardware' | 'software'
  videoCodec: string
  audioCodec: string
  width: number
  height: number
  fps: number
  videoBitrate: number
  audioBitrate: number
  hdr: boolean
}

export type PlayerEvents = {
  status: PlayerStatus
  progress: PlayerProgress
  /** The file is open: its length (0 for a live stream) */
  loaded: { duration: number }
  /** Playback reached the end (or stopped for another reason) */
  ended: { reason: 'ended' | 'error' | 'stopped' | 'unknown' }
  error: { message: string }
}

export interface PlayerPort {
  readonly events: Emitter<PlayerEvents>
  /** Opens a stream at `startAt` seconds; `headers` go with every request (`Name: value`) */
  load(stream: { uri: string; headers: string[] }, startAt: number): void
  play(): void
  pause(): void
  seekTo(seconds: number): void
  setSpeed(speed: number): void
  tracks(): Promise<PlayerTrack[]>
  selectAudio(id: number): void
  /** null: subtitles off */
  selectSubtitle(id: number | null): void
  /** A subtitle file at a URL (sent with the stream's headers), selected at once */
  addSubtitle(url: string, title?: string, language?: string): void
  addAudio(url: string, title?: string, language?: string): void
  /** A player property (subtitle size, position, delay; audio delay) */
  setProperty(name: string, value: string): void
  info(): Promise<PlayerInfo>
}
