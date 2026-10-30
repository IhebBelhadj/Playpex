import type { ApiClient } from '../http/client'
import { getDetails } from '../services/catalog'
import { findSources, playTitle, startSource, type PlaySource, type PlaySources, type PlayTitle, type ResumePoint } from '../services/playback'
import { Disposer } from '../util/disposer'
import { Store } from '../util/store'
import type { SessionRegistry } from './registry'
import { PlaybackSession } from './session'

// Play: every way the server has to play a movie or an episode
// (POST /play/sources), and the one the user taps (POST /play/start). Nothing
// starts by itself: not the release being resumed, not the server's
// `policy.autoplay` (shown as "Best match" only). The server may ask a
// plugin's question first, or refuse; a "play" answer makes a PlaybackSession,
// registered for the player.

export type PlayQuestion = { source: PlaySource; question: string; yes: string; no: string; by: string }

export type RequestState = {
  sources: { kind: 'loading' } | { kind: 'loaded'; answer: PlaySources } | { kind: 'failed'; message: string }
  /** The source being started (its row shows it) */
  starting: string | null
  question: PlayQuestion | null
  refusal: { reason: string; by: string } | null
  error: string | null
}

export type RequestOptions = {
  client: ApiClient
  profileId: string
  title: PlayTitle
  /** Where the profile stopped: its release is offered "from 23:10" */
  resume: ResumePoint | null
  registry: SessionRegistry
}

export class PlayRequest {
  readonly state = new Store<RequestState>({ sources: { kind: 'loading' }, starting: null, question: null, refusal: null, error: null })
  /** The title as the sheet was opened with it, completed from the catalog when it lacked its IMDb id */
  title: PlayTitle
  readonly resume: ResumePoint | null
  private run: Disposer | null = null

  constructor(private readonly options: RequestOptions) {
    this.title = options.title
    this.resume = options.resume
  }

  start(): void {
    if (this.run && !this.run.disposed) return
    const run = (this.run = new Disposer())
    if (this.state.get().sources.kind !== 'loaded') void this.load(run)
  }

  stop(): void {
    this.run?.dispose()
  }

  reload(): void {
    this.stop()
    this.state.patch({ sources: { kind: 'loading' }, error: null })
    this.start()
  }

  /** The release the profile was watching, when the server still offers it */
  resumedSource(): PlaySource | null {
    const sources = this.state.get().sources
    if (!this.resume || sources.kind !== 'loaded') return null
    const { fileId, infoHash, filePath } = this.resume
    const list = sources.answer.sources
    const name = baseName(filePath)
    return (
      list.find((s) => (fileId && s.ref === 'f_' + fileId) || (!!infoHash && s.infoHash === infoHash)) ??
      // A torrent watched while it downloaded, now a file on the server (the library found the finished download)
      (name ? list.find((s) => baseName(s.path ?? s.label) === name) : undefined) ??
      null
    )
  }

  /**
   * Plays `source` because the user tapped it. `resume`: from the resume point (only for the
   * release it belongs to). Answers the session to open in the player, or null (asked, refused,
   * failed, or the sheet closed meanwhile).
   */
  async choose(source: PlaySource, choice: { resume?: boolean; confirmed?: boolean } = {}): Promise<{ sessionId: string } | null> {
    const sources = this.state.get().sources
    if (sources.kind !== 'loaded' || this.state.get().starting) return null
    const run = this.run
    this.state.patch({ starting: source.id, question: null, refusal: null, error: null })
    try {
      const answer = await startSource(this.options.client, sources.answer.request, source, choice.confirmed)
      if (!run || run.disposed) return null
      if (answer.action === 'ask') {
        this.state.patch({ starting: null, question: { source, question: answer.question, yes: answer.yes, no: answer.no, by: answer.by } })
        return null
      }
      if (answer.action === 'refuse') {
        this.state.patch({ starting: null, refusal: { reason: answer.reason, by: answer.by } })
        return null
      }
      const resumes = !!choice.resume && this.resume != null && this.resumedSource()?.id === source.id
      const session = new PlaybackSession({
        client: this.options.client,
        profileId: this.options.profileId,
        title: this.title,
        source: answer.source,
        startAt: resumes ? this.resume!.positionS : 0,
        tracks: resumes ? { audio: this.resume!.audioTrack ?? null, subtitle: this.resume!.subtitleTrack ?? null } : undefined,
      })
      this.state.patch({ starting: null })
      return { sessionId: this.options.registry.add(session) }
    } catch (e) {
      if (run && !run.disposed) this.state.patch({ starting: null, error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  /** The plugin's question answered no */
  dismissQuestion(): void {
    this.state.patch({ question: null })
  }

  private async load(run: Disposer): Promise<void> {
    try {
      // Opened from a card that knew only the TMDB id: the IMDb id sources and subtitles need
      if (this.title.imdbId == null && this.title.mediaType === 'movie') {
        const details = await getDetails(this.options.client, 'movie', this.title.tmdbId)
        if (run.disposed) return
        this.title = playTitle(details)
      }
      const answer = await findSources(this.options.client, this.title, this.options.profileId)
      if (!run.disposed) this.state.patch({ sources: { kind: 'loaded', answer } })
    } catch (e) {
      if (!run.disposed) this.state.patch({ sources: { kind: 'failed', message: e instanceof Error ? e.message : String(e) } })
    }
  }
}

function baseName(path: string | null | undefined): string | null {
  return path ? (path.split('/').pop() ?? null) : null
}
