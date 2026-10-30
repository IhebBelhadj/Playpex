import type { DiscoverParams, ListName } from '../catalog/browse'
import { unwrap, type Schemas } from '../http/api'
import type { ApiClient } from '../http/client'

export type { DiscoverSort, ListName } from '../catalog/browse'

// The catalog through the server (docs/api/catalog.md): TMDB behind it, in our own shapes.

export type Details = Schemas['CatalogDetails']

export function getDetails(client: ApiClient, mediaType: 'movie' | 'tv', tmdbId: number): Promise<Details> {
  return unwrap(client.api.GET('/catalog/titles/{mediaType}/{tmdbId}', { params: { path: { mediaType, tmdbId } } }))
}

export type CatalogTitle = Schemas['CatalogTitle']
export type CatalogPage = Schemas['CatalogPage']

/** One page of a catalogue list (popular, trending…) */
export function listPage(client: ApiClient, mediaType: 'movie' | 'tv', list: ListName, page: number): Promise<CatalogPage> {
  return unwrap(client.api.GET('/catalog/lists/{mediaType}/{list}', { params: { path: { mediaType, list }, query: { page } } }))
}

/** One page of titles by filters and order (core/catalog/browse.ts makes `params`) */
export function discoverPage(client: ApiClient, mediaType: 'movie' | 'tv', params: DiscoverParams, page: number): Promise<CatalogPage> {
  return unwrap(client.api.GET('/catalog/discover/{mediaType}', { params: { path: { mediaType }, query: { page, ...params } } }))
}

export async function genres(client: ApiClient, mediaType: 'movie' | 'tv'): Promise<Schemas['CatalogGenre'][]> {
  return (await unwrap(client.api.GET('/catalog/genres/{mediaType}', { params: { path: { mediaType } } }))).genres
}

/** The titles of a page: people left out */
export function titlesOf(page: CatalogPage | undefined): CatalogTitle[] {
  return (page?.results ?? []).filter((r): r is CatalogTitle => r.mediaType === 'movie' || r.mediaType === 'tv')
}
