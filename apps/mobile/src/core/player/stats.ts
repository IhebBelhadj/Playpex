import type { ApiClient } from '../http/client'
import { torrentStats, type TorrentStats } from '../services/playback'
import { Disposer } from '../util/disposer'
import { Store } from '../util/store'
import type { PlayerInfo, PlayerPort } from './port'

// Stats for nerds: what mpv decodes (and whether in hardware) and, for a
// torrent, its swarm. Read every 2 s while someone looks at them (the panel
// open, or "on screen while watching"), never otherwise.

export const STATS_MS = 2000

export type StatsState = { visible: boolean; onScreen: boolean; info: PlayerInfo | null; swarm: TorrentStats | null }

export class PlayerStats {
  readonly state = new Store<StatsState>({ visible: false, onScreen: false, info: null, swarm: null })
  private run: Disposer | null = null

  constructor(
    private readonly client: ApiClient,
    private readonly player: PlayerPort,
    private readonly infoHash: () => string | null,
  ) {}

  /** The panel shows them (true) or closes (false) */
  watch(visible: boolean): void {
    this.state.patch({ visible })
    this.follow()
  }

  toggleOnScreen(): void {
    this.state.patch({ onScreen: !this.state.get().onScreen })
    this.follow()
  }

  stop(): void {
    this.run?.dispose()
    this.run = null
  }

  private follow(): void {
    const { visible, onScreen } = this.state.get()
    if (!visible && !onScreen) return this.stop()
    if (this.run) return
    const run = (this.run = new Disposer())
    const read = async () => {
      const hash = this.infoHash()
      const [info, swarm] = await Promise.all([this.player.info().catch(() => null), hash ? torrentStats(this.client, hash).catch(() => null) : Promise.resolve(null)])
      if (!run.disposed) this.state.patch({ info, swarm })
    }
    void read()
    run.interval(STATS_MS, () => void read())
  }
}
