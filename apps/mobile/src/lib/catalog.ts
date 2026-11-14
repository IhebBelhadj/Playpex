import { useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import { unwrap, type Schemas } from './api'
import { useApi, useSession } from './session'

// The catalog through the server (docs/api/catalog.md): TMDB behind it, no key
// here. Images load from `imageBase` directly.

export type Title = Schemas['CatalogTitle']
export type Details = Schemas['CatalogDetails']
export type Season = Schemas['CatalogSeason']
export type Episode = Schemas['CatalogEpisode']
export type Person = Schemas['CatalogPerson']
export type PersonDetails = Schemas['CatalogPersonDetails']
export type PersonCredit = Schemas['CatalogPersonCredit']
export type MediaType = 'movie' | 'tv'

const HOUR = 60 * 60 * 1000
const FALLBACK_IMAGE_BASE = 'https://image.tmdb.org/t/p/'

export function useImageBase(): string {
  const { api } = useSession()
  const info = useQuery({
    queryKey: ['catalog'],
    queryFn: () => unwrap(api!.GET('/catalog')),
    enabled: !!api,
    staleTime: 6 * HOUR,
  })
  return info.data?.imageBase ?? FALLBACK_IMAGE_BASE
}

/** Poster `w342`, backdrop `w780`, still `w300`, profile `w185`: the smallest that covers a phone's tiles */
export function image(base: string, path: string | null | undefined, size: string): string | undefined {
  return path ? base + size + path : undefined
}

export function useCatalogList(mediaType: MediaType, list: string) {
  const api = useApi()
  return useQuery({
    queryKey: ['catalog', 'list', mediaType, list],
    queryFn: () =>
      unwrap(
        api.GET('/catalog/lists/{mediaType}/{list}', {
          params: { path: { mediaType, list: list as never }, query: { page: 1 } },
        }),
      ),
    staleTime: HOUR,
  })
}

export function useDetails(mediaType: MediaType, tmdbId: number) {
  const api = useApi()
  return useQuery({
    queryKey: ['catalog', 'title', mediaType, tmdbId],
    queryFn: () => unwrap(api.GET('/catalog/titles/{mediaType}/{tmdbId}', { params: { path: { mediaType, tmdbId } } })),
    staleTime: 6 * HOUR,
  })
}

export function useSeason(tmdbId: number, season: number | null) {
  const api = useApi()
  return useQuery({
    queryKey: ['catalog', 'season', tmdbId, season],
    queryFn: () =>
      unwrap(api.GET('/catalog/titles/tv/{tmdbId}/seasons/{season}', { params: { path: { tmdbId, season: season! } } })),
    enabled: season != null,
    staleTime: 6 * HOUR,
  })
}

export function useCredits(mediaType: MediaType, tmdbId: number) {
  const api = useApi()
  return useQuery({
    queryKey: ['catalog', 'credits', mediaType, tmdbId],
    queryFn: () =>
      unwrap(api.GET('/catalog/titles/{mediaType}/{tmdbId}/credits', { params: { path: { mediaType, tmdbId } } })),
    staleTime: 6 * HOUR,
  })
}

/** A person's page (docs/people-plan.md §3.1): who they are, their titles with every role merged */
export function usePerson(personId: number) {
  const api = useApi()
  return useQuery({
    queryKey: ['catalog', 'person', personId],
    queryFn: () => unwrap(api.GET('/catalog/people/{personId}', { params: { path: { personId } } })),
    enabled: personId > 0,
    staleTime: 6 * HOUR,
  })
}

/** Opens a person's page; their name and face, drawn at once while it loads */
export function openPerson(personId: number, from?: { name?: string; profilePath?: string | null }) {
  router.push({ pathname: '/person/[id]', params: { id: String(personId), name: from?.name ?? '', face: from?.profilePath ?? '' } })
}

export function useImdbRating(imdbId: string | null | undefined) {
  const api = useApi()
  return useQuery({
    queryKey: ['imdb', imdbId],
    queryFn: () => unwrap(api.GET('/imdb/{imdbId}', { params: { path: { imdbId: imdbId! } } })),
    enabled: !!imdbId,
    staleTime: 6 * HOUR,
    retry: false,
  })
}

/** Rows of the Home, Movies and Shows tabs: the server's lists (docs/api/catalog.md#routes) */
export const ROWS: Record<'home' | MediaType, { mediaType: MediaType; list: string; label: string }[]> = {
  home: [
    { mediaType: 'movie', list: 'trending', label: 'Trending movies' },
    { mediaType: 'tv', list: 'trending', label: 'Trending shows' },
    { mediaType: 'movie', list: 'now_playing', label: 'New in cinemas' },
    { mediaType: 'tv', list: 'top_rated', label: 'Top rated shows' },
  ],
  movie: [
    { mediaType: 'movie', list: 'popular', label: 'Popular' },
    { mediaType: 'movie', list: 'trending', label: 'Trending this week' },
    { mediaType: 'movie', list: 'now_playing', label: 'Now playing' },
    { mediaType: 'movie', list: 'top_rated', label: 'Top rated' },
    { mediaType: 'movie', list: 'upcoming', label: 'Coming soon' },
  ],
  tv: [
    { mediaType: 'tv', list: 'popular', label: 'Popular' },
    { mediaType: 'tv', list: 'trending', label: 'Trending this week' },
    { mediaType: 'tv', list: 'airing_today', label: 'Airing today' },
    { mediaType: 'tv', list: 'on_the_air', label: 'On the air' },
    { mediaType: 'tv', list: 'top_rated', label: 'Top rated' },
  ],
}
