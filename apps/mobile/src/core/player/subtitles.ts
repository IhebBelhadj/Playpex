import type { ApiClient } from '../http/client'
import { searchSubtitles, subtitleFileUrl, subtitleProviders, type FoundSubtitle, type SubtitleProvider } from '../services/subtitles'
import type { PlayTitle } from '../services/playback'
import { Store } from '../util/store'

// Online subtitles for the title playing: the server's providers, the results
// of one (the profile's `subtitles.provider`, else the first), and the file of
// the one chosen, which the player adds as a track.

export type OnlineSubtitlesState = {
  providers: SubtitleProvider[] | null
  provider: string | null
  /** null while looking */
  results: FoundSubtitle[] | null
  error: string | null
  chosen: FoundSubtitle | null
}

export class OnlineSubtitles {
  readonly state = new Store<OnlineSubtitlesState>({ providers: null, provider: null, results: null, error: null, chosen: null })
  private opened = false

  constructor(
    private readonly client: ApiClient,
    private readonly title: PlayTitle,
    /** The profile's provider (Settings) */
    private readonly preferred: () => Promise<string | null>,
    /** Remembers the provider picked here for the profile */
    private readonly remember: (provider: string) => void,
  ) {}

  /** The panel opens: providers and the first search, once */
  open(): void {
    if (this.opened) return
    this.opened = true
    void Promise.all([subtitleProviders(this.client, this.title), this.preferred().catch(() => null)])
      .then(([providers, preferred]) => {
        this.state.patch({ providers })
        const first = providers.find((p) => p.id === preferred) ?? providers[0]
        if (first) this.search(first.id)
        else this.state.patch({ results: [], error: 'No subtitle source is turned on. Turn one on in the server’s dashboard.' })
      })
      .catch(() => {
        this.opened = false
        this.state.patch({ providers: [], results: [], error: 'The subtitle service isn’t answering. Try again in a moment.' })
      })
  }

  /** Another provider, remembered for the profile */
  switchTo(provider: string): void {
    if (provider === this.state.get().provider) return
    this.remember(provider)
    this.search(provider)
  }

  choose(subtitle: FoundSubtitle | null): { url: string; title: string; language: string } | null {
    this.state.patch({ chosen: subtitle })
    if (!subtitle) return null
    return { url: subtitleFileUrl(this.client, subtitle), title: subtitle.name || subtitle.languageName || subtitle.language, language: subtitle.language }
  }

  private search(provider: string): void {
    this.state.patch({ provider, results: null, error: null })
    if (!this.title.imdbId) {
      this.state.patch({ results: [], error: 'This title has no IMDb id, so subtitles can’t be looked up.' })
      return
    }
    void searchSubtitles(this.client, provider, this.title)
      .then((results) => {
        if (this.state.get().provider === provider) this.state.patch({ results, error: results.length ? null : 'This source has no subtitles for this title. Try another source.' })
      })
      .catch(() => {
        if (this.state.get().provider === provider) this.state.patch({ results: [], error: 'This source isn’t answering. Try another one.' })
      })
  }
}
