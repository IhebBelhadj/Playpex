import { useSyncExternalStore } from 'react'
import { StyleSheet } from 'react-native'
import { ExpoMpvView, type ExpoMpvViewRef, type TrackInfo } from '../../modules/expo-mpv/src'
import type { PlayerEvents, PlayerInfo, PlayerPort, PlayerTrack } from '../core/player/port'
import { Emitter } from '../core/util/emitter'
import { Store } from '../core/util/store'

// libmpv (modules/expo-mpv) as the app's PlayerPort. The native view takes its
// source as props: they live in `props`, and <MpvSurface> renders from them.
// Everything else, pause and speed included, goes through the view's ref: a
// prop is sent again only when it changes, so a `paused` prop missed mpv's own
// pauses (the end, a seek past the cache) and Play then sent nothing. mpv
// decodes every container and codec on the phone (hardware first, FFmpeg otherwise).

type SurfaceProps = { source: string | null; headers: string[]; startAt: number }

export class MpvPlayer implements PlayerPort {
  readonly events = new Emitter<PlayerEvents>()
  readonly props = new Store<SurfaceProps>({ source: null, headers: [], startAt: 0 })
  private view: ExpoMpvViewRef | null = null
  /** mpv's own pause state, and whether it waits for data: the status the app sees combines them */
  private paused = false
  private buffering = false
  /** From a file's opening to its first frame (mpv still reads it: a torrent's index, the resume point) */
  private loading = true

  /** The native view, from <MpvSurface>'s ref (null when it unmounts) */
  attach(view: ExpoMpvViewRef | null): void {
    this.view = view
  }

  load(stream: { uri: string; headers: string[] }, startAt: number): void {
    this.loading = true
    this.props.set({ source: stream.uri, headers: stream.headers, startAt })
    // A file opened after another (a torrent's next file) plays even if the last one was paused
    void this.view?.play()
  }

  play(): void {
    void this.view?.play()
  }

  pause(): void {
    void this.view?.pause()
  }

  /** From the view's events: mpv loading (no frame yet), paused or playing, and waiting for data or not */
  onState(state: string): void {
    this.loading = state === 'loading'
    if (!this.loading) this.paused = state === 'paused'
    this.emitStatus()
  }

  onBuffer(buffering: boolean): void {
    this.buffering = buffering
    this.emitStatus()
  }

  private emitStatus(): void {
    this.events.emit('status', this.loading ? 'loading' : this.paused ? 'paused' : this.buffering ? 'buffering' : 'playing')
  }

  seekTo(seconds: number): void {
    void this.view?.seekTo(seconds)
  }

  setSpeed(speed: number): void {
    void this.view?.setSpeed(speed)
  }

  async tracks(): Promise<PlayerTrack[]> {
    const list = (await this.view?.getTrackList().catch(() => [])) ?? []
    return list.filter((t) => t.type === 'audio' || t.type === 'sub' || t.type === 'video').map(toTrack)
  }

  selectAudio(id: number): void {
    void this.view?.setAudioTrack(id)
  }

  selectSubtitle(id: number | null): void {
    void (id == null ? this.view?.setPropertyString('sid', 'no') : this.view?.setSubtitleTrack(id))
  }

  addSubtitle(url: string, title?: string, language?: string): void {
    void this.view?.addSubtitle(url, 'select', title, language)
  }

  addAudio(url: string, title?: string, language?: string): void {
    void this.view?.addAudio(url, 'select', title, language)
  }

  setProperty(name: string, value: string): void {
    // A property this mpv lacks (an older build) changes nothing
    void this.view?.setPropertyString(name, value).catch(() => {})
  }

  async info(): Promise<PlayerInfo> {
    const m = await this.view?.getMediaInfo().catch(() => null)
    return {
      decoder: m?.hwdecCurrent ? 'hardware' : 'software',
      videoCodec: m?.videoCodec ?? '',
      audioCodec: m?.audioCodec ?? '',
      width: m?.width ?? 0,
      height: m?.height ?? 0,
      fps: m?.fps ?? 0,
      videoBitrate: m?.videoBitrate ?? 0,
      audioBitrate: m?.audioBitrate ?? 0,
      hdr: m?.isHdr ?? false,
    }
  }
}

function toTrack(t: TrackInfo): PlayerTrack {
  return {
    id: t.id,
    kind: t.type === 'sub' ? 'subtitle' : (t.type as 'audio' | 'video'),
    title: t.title,
    language: t.lang,
    codec: t.codec,
    selected: t.selected,
    external: t.isExternal,
    channels: t.channelCount,
  }
}

/** The video itself: full size, drawn from the player's props, its events sent out as the port's */
export function MpvSurface({ player }: { player: MpvPlayer }) {
  const props = useSyncExternalStore(player.props.subscribe, player.props.get, player.props.get)
  if (!props.source) return null
  const { events } = player
  return (
    <ExpoMpvView
      ref={(view) => player.attach(view)}
      source={props.source}
      httpHeaders={props.headers}
      startPosition={props.startAt}
      style={StyleSheet.absoluteFill}
      onLoad={({ nativeEvent }) => events.emit('loaded', { duration: nativeEvent.duration })}
      onProgress={({ nativeEvent: p }) =>
        events.emit('progress', { position: p.position, duration: p.duration, bufferedTo: p.bufferedPosition, cacheAhead: p.bufferedDuration, networkRate: p.bufferRate })
      }
      onPlaybackStateChange={({ nativeEvent }) => player.onState(nativeEvent.state)}
      onBuffer={({ nativeEvent }) => player.onBuffer(nativeEvent.isBuffering)}
      onEnd={({ nativeEvent }) => events.emit('ended', { reason: nativeEvent.reason })}
      onError={({ nativeEvent }) => events.emit('error', { message: nativeEvent.error || 'The video stopped with an error.' })}
    />
  )
}
