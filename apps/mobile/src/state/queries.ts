import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../core/http/client'
import { discoverParams, showsList, type BrowseQuery } from '../core/catalog/browse'
import { discoverPage, genres, listPage } from '../core/services/catalog'
import { listProfiles } from '../core/services/profiles'
import { findPage, finders, type Finder, type Quality, type ReleaseKind } from '../core/services/releases'
import { getServerInfo } from '../core/services/server'
import { getSettings } from '../core/services/settings'

// Every server answer the screens read, as TanStack Query options: one key
// factory per area (the only place keys are written: invalidation.ts and the
// mutations use the same), one options function per question. The caches
// belong to one server: the app clears them when the server changes.

const HOUR = 60 * 60 * 1000

export const keys = {
  profiles: () => ['profiles'] as const,
  genres: (mediaType: 'movie' | 'tv') => ['catalog', 'genres', mediaType] as const,
  browse: (mediaType: 'movie' | 'tv', query: BrowseQuery) => ['catalog', 'browse', mediaType, query] as const,
  settings: (profileId: string) => ['settings', profileId] as const,
  server: () => ['server'] as const,
  finders: (kind: ReleaseKind) => ['releases', 'finders', kind] as const,
  found: (finder: string, kind: ReleaseKind, q: string, quality: Quality | null) => ['releases', 'found', finder, kind, q, quality] as const,
}

export const queries = {
  profiles: (client: ApiClient) => queryOptions({ queryKey: keys.profiles(), queryFn: () => listProfiles(client) }),

  genres: (client: ApiClient, mediaType: 'movie' | 'tv') => queryOptions({ queryKey: keys.genres(mediaType), queryFn: () => genres(client, mediaType), staleTime: 24 * HOUR }),

  /** A catalogue to scroll through: a list as the server ranks it, or titles by filters in an order; pages as the grid scrolls */
  browse: (client: ApiClient, mediaType: 'movie' | 'tv', query: BrowseQuery) =>
    infiniteQueryOptions({
      queryKey: keys.browse(mediaType, query),
      initialPageParam: 1,
      queryFn: ({ pageParam }) => (showsList(query) ? listPage(client, mediaType, query.list, pageParam) : discoverPage(client, mediaType, discoverParams(query), pageParam)),
      getNextPageParam: (last) => (last.page < Math.min(last.totalPages, 500) ? last.page + 1 : undefined),
      staleTime: HOUR,
    }),

  /** This phone's settings and the profile's, with their defaults (GET /settings) */
  settings: (client: ApiClient, profileId: string) => queryOptions({ queryKey: keys.settings(profileId), queryFn: () => getSettings(client, profileId), staleTime: 5 * 60 * 1000 }),

  server: (client: ApiClient) => queryOptions({ queryKey: keys.server(), queryFn: () => getServerInfo(client), staleTime: 10 * 60 * 1000 }),

  finders: (client: ApiClient, kind: ReleaseKind) => queryOptions({ queryKey: keys.finders(kind), queryFn: () => finders(client, kind), staleTime: 10 * 60 * 1000 }),

  /** One finder's results for keywords, page by page */
  found: (client: ApiClient, finder: Finder, query: { kind: ReleaseKind; q: string; quality: Quality | null; imdb: string | null }) =>
    infiniteQueryOptions({
      queryKey: keys.found(finder.id, query.kind, query.q, query.quality),
      initialPageParam: 1,
      queryFn: ({ pageParam }) => findPage(client, finder, { ...query, page: pageParam }),
      getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
      staleTime: 5 * 60 * 1000,
    }),
}
