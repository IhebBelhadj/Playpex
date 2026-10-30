import { unwrap, type Schemas } from '../http/api'
import type { ApiClient } from '../http/client'
import type { PlaySource } from './playback'

// Find releases (docs/api/search.md, releases): every torrent provider's
// releases for keywords (GET /releases/browse, most seeded first) and every
// stream provider's results (GET /search/sources), as one kind of row the
// page lists and the player plays.

export type ReleaseKind = 'movie' | 'tv'
export type Quality = '2160p' | '1080p' | '720p' | 'SD'

/** A place to search: a torrent provider (release lists) or a stream provider (plugins' sources.search) */
export type Finder = { id: string; name: string; kind: 'torrents' | 'streams'; default: boolean }

/** One result, whatever found it */
export type Found = {
  key: string
  finder: string
  kind: 'torrent' | 'file' | 'hls'
  /** What it is (the cleaned title), else its name */
  title: string
  /** The release's own name */
  name: string
  year: number | null
  season: number | null
  episode: number | null
  pack: boolean
  seeds: number | null
  peers: number | null
  size: number | null
  quality: string | null
  codec: string | null
  audio: string | null
  /** Every keyword is in its name */
  matches: boolean
  magnet?: string
  infoHash?: string
  ref?: string
  /** A stream's picture, when its provider has one (an https image) */
  poster?: string | null
}

export type FoundPage = { items: Found[]; page: number; hasMore: boolean }

export async function finders(client: ApiClient, kind: ReleaseKind): Promise<Finder[]> {
  const [torrents, streams] = await Promise.all([
    unwrap(client.api.GET('/releases/providers', { params: { query: { kind } } })).catch(() => [] as Schemas['ReleaseProvider'][]),
    unwrap(client.api.GET('/search/providers')).catch(() => [] as Schemas['SearchProvider'][]),
  ])
  return [
    ...torrents.map((p) => ({ id: p.id, name: p.name, kind: 'torrents' as const, default: p.default })),
    ...streams.map((p) => ({ id: p.id, name: p.name, kind: 'streams' as const, default: false })),
  ]
}

export async function findPage(
  client: ApiClient,
  finder: Finder,
  query: { kind: ReleaseKind; q: string; quality: Quality | null; imdb?: string | null; page: number },
): Promise<FoundPage> {
  if (finder.kind === 'torrents') {
    const answer = await unwrap(
      client.api.GET('/releases/browse', {
        params: {
          query: {
            kind: query.kind,
            provider: finder.id,
            page: query.page,
            ...(query.q ? { q: query.q } : {}),
            ...(query.quality ? { quality: query.quality } : {}),
            ...(query.imdb ? { imdb: query.imdb } : {}),
          },
        },
      }),
    )
    return { items: answer.torrents.map((t) => fromTorrent(finder.id, t)), page: answer.page, hasMore: answer.hasMore }
  }
  if (!query.q) return { items: [], page: 1, hasMore: false }
  const answer = await unwrap(
    client.api.GET('/search/sources', { params: { query: { provider: finder.id, q: query.q, kind: query.kind === 'tv' ? 'show' : 'movie', page: query.page } } }),
  )
  return { items: answer.items.map((s, i) => fromSource(finder.id, s, query.page, i)), page: answer.page, hasMore: answer.hasMore }
}

export function fromTorrent(finder: string, t: Schemas['ReleaseTorrent']): Found {
  return {
    key: t.hash,
    finder,
    kind: 'torrent',
    title: t.title ?? t.name,
    name: t.name,
    year: t.year ?? null,
    season: t.season ?? null,
    episode: t.episode ?? null,
    pack: t.pack ?? false,
    seeds: t.seeds,
    peers: t.peers ?? null,
    size: t.size ?? null,
    quality: t.quality ?? null,
    codec: t.codec ?? null,
    audio: t.audio ?? null,
    matches: t.matches ?? true,
    magnet: t.magnet,
    infoHash: t.hash,
  }
}

export function fromSource(finder: string, s: Schemas['SearchSource'], page: number, i: number): Found {
  return {
    key: s.infoHash ?? s.ref ?? `${finder}:${page}:${i}`,
    finder,
    kind: s.kind,
    title: s.title ?? s.label,
    name: s.label,
    year: s.year ?? null,
    season: s.season ?? null,
    episode: s.episode ?? null,
    pack: false,
    seeds: s.seeds ?? null,
    peers: s.peers ?? null,
    size: s.size ?? null,
    quality: s.quality ?? null,
    codec: s.codec ?? null,
    audio: s.audio ?? null,
    matches: s.matches,
    magnet: s.magnet,
    infoHash: s.infoHash,
    ref: s.ref,
  }
}

/** What the player plays for a result: a torrent like the core's, or a stream the server proxies */
export function playSourceOf(found: Found): PlaySource {
  const base = { provider: found.finder, label: found.name, playable: 'yes' as const, badges: [], notes: [], size: found.size, quality: found.quality, codec: found.codec, audio: found.audio }
  if (found.kind === 'torrent') return { ...base, id: `torrent:${found.infoHash}`, type: 'torrent', magnet: found.magnet, infoHash: found.infoHash } as PlaySource
  return { ...base, id: found.ref!, type: 'plugin', ref: found.ref, format: found.kind === 'hls' ? 'hls' : 'file' } as PlaySource
}
