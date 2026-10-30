import { useQuery } from '@tanstack/react-query'
import { unwrap, type Schemas } from './api'
import { useApi, useProfile } from './session'
import { useClient } from '../state/app'
import { queries } from '../state/queries'
import type { MediaType, Title } from './catalog'

// What Home suggests to this profile, from what it watched (docs/api/profiles.md
// history, its genres) and the catalog (similar titles, discover by genre,
// trending): no model on the server, only the profile's own history.

const HOUR = 60 * 60 * 1000

export type History = Schemas['HistoryEntry'][]

export function useHistory() {
  const api = useApi()
  const profile = useProfile()
  return useQuery({
    queryKey: ['library', 'history', profile.id],
    queryFn: () => unwrap(api.GET('/profiles/{profileId}/history', { params: { path: { profileId: profile.id } } })),
    staleTime: 5 * 60 * 1000,
  })
}

/** The titles watched, newest first, one entry per title */
export function watchedTitles(history: History | undefined): History {
  const seen = new Set<string>()
  return (history ?? []).filter((h) => {
    const key = h.mediaType + h.tmdbId
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The genres this profile watches most, each title counted once */
export function favouriteGenres(history: History | undefined, mediaType: MediaType, count = 2): number[] {
  const score = new Map<number, number>()
  for (const h of watchedTitles(history)) {
    if (h.mediaType !== mediaType) continue
    for (const g of h.genreIds ?? []) score.set(g, (score.get(g) ?? 0) + 1)
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([g]) => g)
}

export function useSimilar(mediaType: MediaType, tmdbId: number | undefined) {
  const api = useApi()
  return useQuery({
    queryKey: ['catalog', 'similar', mediaType, tmdbId],
    queryFn: () =>
      unwrap(api.GET('/catalog/titles/{mediaType}/{tmdbId}/similar', { params: { path: { mediaType, tmdbId: tmdbId! }, query: { page: 1 } } })),
    enabled: tmdbId != null,
    staleTime: 6 * HOUR,
    select: (page) => titlesOf(page.results),
  })
}

export function useDiscover(mediaType: MediaType, genres: number[], sort: 'popularity' | 'rating' | 'newest' = 'popularity') {
  const api = useApi()
  return useQuery({
    queryKey: ['catalog', 'discover', mediaType, genres.join('|'), sort],
    queryFn: () =>
      unwrap(
        api.GET('/catalog/discover/{mediaType}', {
          params: { path: { mediaType }, query: { page: 1, sort, genres: genres.join('|'), minVotes: 200 } },
        }),
      ),
    enabled: genres.length > 0,
    staleTime: HOUR,
    select: (page) => titlesOf(page.results),
  })
}

/** The genres by id: through state/queries' genres (one key, one shape for every screen) */
export function useGenres(mediaType: MediaType) {
  const client = useClient()
  return useQuery({ ...queries.genres(client, mediaType), select: (list) => new Map(list.map((g) => [g.id, g.name])) })
}

export function titlesOf(results: Schemas['CatalogPage']['results'] | undefined): Title[] {
  return (results ?? []).filter((r): r is Title => r.mediaType === 'movie' || r.mediaType === 'tv')
}

/** Leaves out what this profile has already watched, and titles without pictures */
export function unseen(titles: Title[] | undefined, history: History | undefined): Title[] {
  const watched = new Set(watchedTitles(history).map((h) => h.mediaType + h.tmdbId))
  return (titles ?? []).filter((t) => t.backdropPath && t.posterPath && !watched.has(t.mediaType + t.tmdbId))
}
