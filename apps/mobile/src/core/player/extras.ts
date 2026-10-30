import type { ApiClient } from '../http/client'
import type { SessionRegistry } from '../playback/registry'
import { Disposer } from '../util/disposer'
import type { PlayerController } from './controller'
import { Markers } from './markers'
import type { PlayerPort } from './port'
import { PlayerStats } from './stats'
import { OnlineSubtitles } from './subtitles'
import { UpNext } from './upNext'

// What the player does around the video, as the TV's player does: plugins'
// markers (Skip intro, where the credits start), Up next for an episode,
// online subtitles, stats. Each is its own controller; this starts and stops
// them with the screen, and asks for a file's markers once its length is known.

export type ExtrasOptions = {
  client: ApiClient
  profileId: string
  registry: SessionRegistry
  /** The profile's subtitle provider, and remembering another one */
  subtitleProvider: () => Promise<string | null>
  rememberSubtitleProvider: (provider: string) => void
  /** The profile's `player.autoplayNext`: the next episode plays when this one ends */
  autoplayNext: () => Promise<boolean>
  /** The next episode's session is ready: the player shows it in place of this one */
  onNext: (sessionId: string) => void
}

export class PlayerExtras {
  readonly markers: Markers
  readonly upNext: UpNext
  readonly subtitles: OnlineSubtitles
  readonly stats: PlayerStats
  private run: Disposer | null = null

  constructor(
    private readonly controller: PlayerController,
    player: PlayerPort,
    private readonly options: ExtrasOptions,
  ) {
    const { session } = controller
    // A plugin's `tracking: 'none'` (or a release played as no title): nothing of the title is looked up
    const tracked = session.tracked && session.title.tmdbId > 0
    this.markers = new Markers(options.client, session.title, tracked)
    this.upNext = new UpNext(options.client, options.profileId, session.title, options.registry, tracked)
    this.subtitles = new OnlineSubtitles(options.client, session.title, options.subtitleProvider, options.rememberSubtitleProvider)
    this.stats = new PlayerStats(options.client, player, () => {
      const status = session.state.get().status
      return status.phase === 'ready' ? status.target.infoHash : null
    })
  }

  start(): void {
    if (this.run && !this.run.disposed) return
    const run = (this.run = new Disposer())
    this.upNext.start()
    run.add(() => this.upNext.stop())
    run.add(() => this.stats.stop())
    const ask = () => {
      const status = this.controller.session.state.get().status
      const { duration } = this.controller.state.get()
      if (status.phase === 'ready' && !status.stream.live && duration > 0) this.markers.load(status.target.ref, duration, { name: status.target.filePath ?? status.target.name, size: status.target.size })
    }
    run.add(this.controller.state.subscribe(ask))
    ask()
    // Up next: its source looked up a little before it shows, so Play now starts at once
    run.add(
      this.controller.state.subscribe(() => {
        const { position, duration } = this.controller.state.get()
        if (this.upNext.state.get().next && duration > 0 && duration - position <= this.markers.upNextWindow(duration) + 15) void this.upNext.lookUp()
      }),
    )
    run.add(this.controller.events.on('finished', () => void this.playNext(true)))
  }

  /** The next episode in this player; `auto`: because this one ended (the profile's setting decides) */
  async playNext(auto = false): Promise<void> {
    const run = this.run
    const { next, dismissed } = this.upNext.state.get()
    if (!next || (auto && dismissed)) return
    if (auto && !(await this.options.autoplayNext().catch(() => true))) return
    const id = await this.upNext.play()
    if (id && run && !run.disposed) this.options.onNext(id)
  }

  stop(): void {
    this.run?.dispose()
  }
}
