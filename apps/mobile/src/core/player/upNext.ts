import type { ApiClient } from '../http/client'
import type { SessionRegistry } from '../playback/registry'
import { PlaybackSession } from '../playback/session'
import { bestSource, findSources, getResume, nextEpisode, startSource, type Episode, type PlaySource, type PlaySources, type PlayTitle } from '../services/playback'
import { Disposer } from '../util/disposer'
import { Store } from '../util/store'

// "Up next" for an episode: the one after it (the catalog), and its best
// source, looked up ahead (when Up next shows) so "Play now" starts at once.
// play() makes the next session, from where the profile stopped in it.

export type UpNextState = {
  next: { title: PlayTitle; episode: Episode; code: string } | null
  source: PlaySource | null
  looking: boolean
  /** Looked up and nothing found, or the plugins refused it */
  missing: string | null
  dismissed: boolean
}

export class UpNext {
  readonly state = new Store<UpNextState>({ next: null, source: null, looking: false, missing: null, dismissed: false })
  private run: Disposer | null = null
  private answer: PlaySources | null = null

  constructor(
    private readonly client: ApiClient,
    private readonly profileId: string,
    private readonly title: PlayTitle,
    private readonly registry: SessionRegistry,
    private readonly enabled: boolean,
  ) {}

  start(): void {
    if (this.run && !this.run.disposed) return
    const run = (this.run = new Disposer())
    if (!this.enabled || this.state.get().next) return
    void nextEpisode(this.client, this.title)
      .then((found) => {
        if (run.disposed || !found) return
        const t = found.title
        this.state.patch({ next: { ...found, code: `S${pad(t.season!)} E${pad(t.episode!)}` } })
      })
      .catch(() => {})
  }

  stop(): void {
    this.run?.dispose()
  }

  dismiss(): void {
    this.state.patch({ dismissed: true })
  }

  /** Its best source, once */
  async lookUp(): Promise<PlaySource | null> {
    const { next, source, looking, missing } = this.state.get()
    if (!next || source || looking || missing) return source
    const run = this.run
    this.state.patch({ looking: true })
    try {
      const answer = await findSources(this.client, next.title, this.profileId)
      if (!run || run.disposed) return null
      this.answer = answer
      const best = bestSource(answer)
      this.state.patch({ looking: false, source: best, missing: best ? null : 'No release found for it' })
      return best
    } catch {
      if (run && !run.disposed) this.state.patch({ looking: false, missing: 'No release found for it' })
      return null
    }
  }

  /** The next episode's session (null: none to play, or a plugin asked or refused) */
  async play(): Promise<string | null> {
    const source = this.state.get().source ?? (await this.lookUp())
    const next = this.state.get().next
    if (!source || !next || !this.answer) return null
    const run = this.run
    try {
      const [answer, resume] = await Promise.all([startSource(this.client, this.answer.request, source), getResume(this.client, this.profileId, next.title)])
      if (!run || run.disposed) return null
      if (answer.action !== 'play') {
        // A question or a refusal needs the title's own Play sheet
        this.state.patch({ missing: answer.action === 'refuse' ? answer.reason : 'Choose its source on the episode’s page' })
        return null
      }
      const session = new PlaybackSession({ client: this.client, profileId: this.profileId, title: next.title, source: answer.source, startAt: resume?.positionS ?? 0 })
      return this.registry.add(session)
    } catch (e) {
      if (run && !run.disposed) this.state.patch({ missing: e instanceof Error ? e.message : String(e) })
      return null
    }
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
