import { unwrap, type Schemas } from '../http/api'
import type { ApiClient } from '../http/client'
import type { PlayTitle } from './playback'

// Online subtitles (docs/api/playback.md): the server's providers, a search
// for the title, and a found subtitle's file (WebVTT) for the player to add.

export type SubtitleProvider = Schemas['SubtitleProvider']
export type FoundSubtitle = Schemas['SubtitleSearch']['subtitles'][number]

/** The providers that are on and cover this kind of title, in the server's order */
export async function subtitleProviders(client: ApiClient, title: PlayTitle): Promise<SubtitleProvider[]> {
  const kind = title.mediaType === 'tv' ? 'episode' : 'movie'
  const all = await unwrap(client.api.GET('/subtitles/providers'))
  return all.filter((p) => p.enabled && p.supports[kind])
}

export async function searchSubtitles(client: ApiClient, provider: string, title: PlayTitle): Promise<FoundSubtitle[]> {
  if (!title.imdbId) return []
  const answer = await unwrap(
    client.api.GET('/subtitles/search', {
      params: { query: { provider, imdb_id: title.imdbId, ...(title.mediaType === 'tv' ? { season: title.season, episode: title.episode } : {}) } },
    }),
  )
  return answer.subtitles
}

/** The file's URL (the player sends the server's headers with it) */
export function subtitleFileUrl(client: ApiClient, subtitle: FoundSubtitle): string {
  const query = new URLSearchParams({ provider: subtitle.provider, ref: subtitle.ref, lang: subtitle.language })
  return client.url(`/subtitles/file?${query.toString()}`)
}
