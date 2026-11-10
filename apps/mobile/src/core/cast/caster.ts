import type { Schemas } from '../http/api'
import { unwrap } from '../http/api'
import type { ApiClient } from '../http/client'
import type { PlaySource, PlayTitle } from '../services/playback'
import { Disposer } from '../util/disposer'
import { Store } from '../util/store'

// Casting from the phone (docs/cast-plan.md §4.3, docs/api/cast.md): the
// screens that take casts (GET /cast/screens), the one chosen in the top bar's
// cast button (while one is, every Play sends there instead of opening this
// phone's player), the cast running there (cast.updated / cast.ended on the
// events socket) and its commands (POST /cast/{id}/commands). "Continue on
// phone" stops it and hands back what it played and where it was.

export type CastScreen = Schemas['CastScreen']
export type Cast = Schemas['Cast']
export type CastRequest = Schemas['CastRequest']
export type CastAction = 'pause' | 'resume' | 'toggle' | 'seek' | 'seekBy' | 'stop'

/** What was cast, for "Continue on phone": the title and source as this app plays them */
export type Casted = { title: PlayTitle; source: PlaySource; tracking: 'full' | 'none' }

export type CasterState = {
  screens: CastScreen[]
  /** Asked at least once (an empty list means none, not "not asked yet") */
  loaded: boolean
  /** The screen Play sends to; null: this phone */
  target: { deviceId: string; name: string } | null
  /** The cast this phone sent last, while it runs */
  cast: Cast | null
  /** What it plays (Continue on phone) */
  casted: Casted | null
  /** A cast being sent */
  sending: boolean
}

export const SCREENS_MS = 15_000

/** What a screen gets for a title and a source this app would play (CastRequest) */
export function castRequest(
  title: PlayTitle,
  source: PlaySource,
  options: { positionS?: number; profileId?: string | null; tracking?: 'full' | 'none' } = {},
): CastRequest | null {
  const cast: CastRequest['source'] | null = source.ref
    ? { ref: source.ref, ...(source.format ? { format: source.format } : {}), ...(source.infoHash ? { infoHash: source.infoHash } : {}), ...(source.path ? { path: source.path } : {}) }
    : source.magnet || source.infoHash
      ? // a .torrent's URL isn't a magnet: its info hash is
        { magnet: source.magnet?.startsWith('magnet:') ? source.magnet : (source.infoHash ?? source.magnet!) }
      : null
  if (!cast) return null
  const episode = title.mediaType === 'tv' && title.season != null && title.episode != null
  const request: CastRequest = {
    title: title.title,
    source: cast,
    tracking: options.tracking === 'none' ? 'none' : 'full',
  }
  if (episode) request.subtitle = `S${pad(title.season!)}E${pad(title.episode!)}${title.episodeName ? ` · ${title.episodeName}` : ''}`
  if (title.year) request.year = String(title.year)
  // tmdbId 0: a release played for no title (nothing saved for it)
  if (title.tmdbId > 0) {
    request.item = {
      mediaType: title.mediaType,
      tmdbId: title.tmdbId,
      ...(title.imdbId ? { imdbId: title.imdbId } : {}),
      ...(episode ? { season: title.season, episode: title.episode } : {}),
    }
  }
  if (title.posterPath || title.backdropPath) {
    request.artwork = { title: title.title, ...(title.posterPath ? { posterPath: title.posterPath } : {}), ...(title.backdropPath ? { backdropPath: title.backdropPath } : {}) }
  }
  if (options.positionS != null && options.positionS > 5) request.positionS = Math.floor(options.positionS)
  if (options.profileId) request.profileId = options.profileId
  if (source.plugin) request.pluginId = source.plugin
  return request
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export class Caster {
  readonly state = new Store<CasterState>({ screens: [], loaded: false, target: null, cast: null, casted: null, sending: false })
  private run: Disposer | null = null

  constructor(private readonly client: ApiClient) {}

  /** Keeps the screens fresh while the app is connected */
  start(): void {
    if (this.run && !this.run.disposed) return
    const run = (this.run = new Disposer())
    void this.refresh()
    run.interval(SCREENS_MS, () => void this.refresh())
  }

  stop(): void {
    this.run?.dispose()
  }

  async refresh(): Promise<CastScreen[]> {
    try {
      const all = await unwrap(this.client.api.GET('/cast/screens'))
      const screens = all.filter((s) => !s.self)
      this.state.patch({ screens, loaded: true })
      return screens
    } catch {
      this.state.patch({ loaded: true })
      return this.state.get().screens
    }
  }

  /** Where Play sends (null: this phone) */
  choose(screen: { deviceId: string; name: string } | null): void {
    this.state.patch({ target: screen ? { deviceId: screen.deviceId, name: screen.name } : null })
  }

  /** The chosen screen while it is on (a screen that went away: Play stays on the phone) */
  targetOnline(): { deviceId: string; name: string } | null {
    const { target, screens } = this.state.get()
    return target && screens.some((s) => s.deviceId === target.deviceId) ? target : null
  }

  /**
   * Casts to `screen` (default: the chosen one). Rejects with the server's sentence
   * (CAST_REFUSED, DEVICE_OFFLINE, UNSUPPORTED…), for a toast.
   */
  async play(what: Casted, options: { positionS?: number; profileId?: string | null; screen?: { deviceId: string; name: string } } = {}): Promise<string> {
    const request = castRequest(what.title, what.source, { positionS: options.positionS, profileId: options.profileId, tracking: what.tracking })
    if (!request) throw new Error('This can’t be played on another screen')
    return this.send(request, what, options.screen)
  }

  /**
   * Casts a request as it is (a YouTube video from a shared link: an `embed` this phone can't
   * play, so `casted` is null and Continue on phone isn't offered)
   */
  async send(request: CastRequest, casted: Casted | null, to?: { deviceId: string; name: string }): Promise<string> {
    const screen = to ?? this.state.get().target
    if (!screen) throw new Error('Choose a screen first')
    const what = casted
    this.state.patch({ sending: true })
    try {
      const { castId } = await unwrap(this.client.api.POST('/cast/screens/{deviceId}/play', { params: { path: { deviceId: screen.deviceId } }, body: request }))
      const now = new Date().toISOString()
      this.state.patch({
        cast: { castId, deviceId: screen.deviceId, from: { deviceId: this.client.deviceId, name: 'This phone' }, sessionId: null, state: 'opening', positionS: request.positionS ?? null, durationS: null, title: request.title, profileId: request.profileId ?? null, error: null, startedAt: now },
        casted: what,
      })
      return castId
    } finally {
      this.state.patch({ sending: false })
    }
  }

  /** cast.updated / cast.ended for this phone's cast */
  onCast(topic: 'cast.updated' | 'cast.ended', cast: Cast): void {
    const current = this.state.get().cast
    if (!current || current.castId !== cast.castId) return
    if (topic === 'cast.ended' || cast.state === 'ended') this.state.patch({ cast: null, casted: null })
    else this.state.patch({ cast })
  }

  async command(action: CastAction, value?: { positionS?: number; deltaS?: number }): Promise<void> {
    const cast = this.state.get().cast
    if (!cast) return
    // the bar answers at once; the screen's report follows
    if (action === 'toggle') this.state.patch({ cast: { ...cast, state: cast.state === 'paused' ? 'playing' : 'paused' } })
    if (action === 'seekBy' && value?.deltaS != null && cast.positionS != null) this.state.patch({ cast: { ...cast, positionS: Math.max(0, cast.positionS + value.deltaS) } })
    if (action === 'seek' && value?.positionS != null) this.state.patch({ cast: { ...cast, positionS: value.positionS } })
    await unwrap(this.client.api.POST('/cast/{castId}/commands', { params: { path: { castId: cast.castId } }, body: { action, ...value } as never }))
    if (action === 'stop') this.state.patch({ cast: null, casted: null })
  }

  /** Continue on phone: the cast stops; what it played and where it was, for this phone's player */
  async takeBack(): Promise<{ casted: Casted; positionS: number } | null> {
    const { cast, casted } = this.state.get()
    if (!cast || !casted) return null
    const positionS = cast.positionS ?? 0
    await this.command('stop').catch(() => {})
    return { casted, positionS }
  }
}
