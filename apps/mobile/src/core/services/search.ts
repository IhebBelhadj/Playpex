import { unwrap, type Schemas } from '../http/api'
import type { ApiClient } from '../http/client'
import type { PlaySource, PlayTitle } from './playback'
import { fromSource, fromTorrent, type Found } from './releases'

// Search for anything the server reaches (docs/search-plan.md, as the
// dashboard's Search): plugins' streams and files of any kind
// (`sources.search`, kind any: not only movies and shows), the release
// providers' torrents (movies and shows: their lists have no other kind), live
// channels, and a pasted link read by the server (POST /links/inspect).

export type LinkInspection = Schemas['LinkInspection']
export type LinkItem = Schemas['LinkItem']
export type LiveChannel = Schemas['LiveChannel']
export type SearchProvider = Schemas['SearchProvider']

/** Whether what was typed is a link to read, not keywords: a URL, a magnet or a bare info hash */
export function isLink(text: string): boolean {
  const t = text.trim()
  return /^(https?:\/\/|magnet:\?)\S+$/i.test(t) || /^(www\.)\S+\.\S+$/i.test(t) || /^[a-f0-9]{40}$/i.test(t)
}

/** A link as the server takes it (a bare www. address gets its https://) */
export function normalizeLink(text: string): string {
  const t = text.trim()
  return /^www\./i.test(t) ? `https://${t}` : t
}

/** What a link is; a magnet or an info hash isn't fetched: it is one torrent */
export async function inspectLink(client: ApiClient, text: string, profileId: string): Promise<LinkInspection> {
  const url = normalizeLink(text)
  if (/^[a-f0-9]{40}$/i.test(url)) return { url, kind: 'magnet', items: [{ kind: 'magnet', label: url.toLowerCase(), url: `magnet:?xt=urn:btih:${url}`, infoHash: url.toLowerCase() }] }
  return unwrap(client.api.POST('/links/inspect', { body: { url, profileId } }))
}

/** A link's item as a source the player opens: a video or stream by its ref, a magnet or a .torrent as a torrent */
export function linkSource(item: LinkItem): PlaySource {
  const base = { provider: 'links', label: item.label, playable: 'yes' as const, badges: [], notes: [], size: item.size ?? null }
  if (item.kind === 'video' || item.kind === 'hls') return { ...base, id: item.ref!, type: 'plugin', ref: item.ref, format: item.kind === 'hls' ? 'hls' : 'file' } as PlaySource
  // a .torrent's URL goes to POST /torrents as it is (the server fetches it)
  return { ...base, id: `torrent:${item.infoHash ?? item.url}`, type: 'torrent', magnet: item.url, infoHash: item.infoHash } as PlaySource
}

/** What the player names a video that is no title of the catalog: nothing of it is saved */
export function looseTitle(label: string, year: number | null = null): PlayTitle {
  return { mediaType: 'movie', tmdbId: 0, imdbId: null, title: label, year, posterPath: null, backdropPath: null }
}

export async function streamProviders(client: ApiClient): Promise<SearchProvider[]> {
  return unwrap(client.api.GET('/search/providers')).catch(() => [])
}

/** One provider's streams and files for keywords, whatever they are */
export async function searchStreams(client: ApiClient, provider: string, q: string): Promise<Found[]> {
  const answer = await unwrap(client.api.GET('/search/sources', { params: { query: { provider, q, kind: 'any', page: 1 } } }))
  return answer.items.map((s, i) => ({ ...fromSource(provider, s, 1, i), poster: s.poster ?? null }))
}

export type TorrentProvider = { id: string; name: string; kinds: ('movie' | 'tv')[] }

/** The release providers, with the kinds each lists */
export async function torrentProviders(client: ApiClient): Promise<TorrentProvider[]> {
  const [movies, shows] = await Promise.all(
    (['movie', 'tv'] as const).map((kind) => unwrap(client.api.GET('/releases/providers', { params: { query: { kind } } })).catch(() => [] as Schemas['ReleaseProvider'][])),
  )
  const byId = new Map<string, TorrentProvider>()
  for (const [kind, list] of [['movie', movies], ['tv', shows]] as const) {
    for (const p of list) {
      const known = byId.get(p.id) ?? { id: p.id, name: p.name, kinds: [] }
      known.kinds.push(kind)
      byId.set(p.id, known)
    }
  }
  return [...byId.values()]
}

/** A provider's torrents for keywords, in every kind it lists, one per info hash, most seeded first */
export async function searchTorrents(client: ApiClient, provider: TorrentProvider, q: string): Promise<Found[]> {
  const pages = await Promise.all(
    provider.kinds.map((kind) =>
      unwrap(client.api.GET('/releases/browse', { params: { query: { kind, provider: provider.id, q, page: 1 } } }))
        .then((a) => a.torrents)
        .catch(() => [] as Schemas['ReleaseTorrent'][]),
    ),
  )
  const seen = new Set<string>()
  return pages
    .flat()
    .filter((t) => !seen.has(t.hash) && !!seen.add(t.hash))
    .map((t) => fromTorrent(provider.id, t))
    .sort((a, b) => (b.seeds ?? 0) - (a.seeds ?? 0))
}

export async function liveProviders(client: ApiClient, profileId: string): Promise<Schemas['LiveProvider'][]> {
  return unwrap(client.api.GET('/live', { params: { query: { profile: profileId } } }))
    .then((a) => a.providers)
    .catch(() => [])
}

/** A live plugin's channels whose name, number or group holds the words */
export async function searchChannels(client: ApiClient, plugin: string, q: string, profileId: string): Promise<LiveChannel[]> {
  const answer = await unwrap(client.api.GET('/live/{pluginId}/channels', { params: { path: { pluginId: plugin }, query: { q, profile: profileId } } }))
  return answer.channels
}

/** A channel's stream now, as a source for the player */
export async function channelSource(client: ApiClient, plugin: string, channel: LiveChannel, profileId: string): Promise<PlaySource> {
  const answer = await unwrap(
    client.api.POST('/live/{pluginId}/channels/{channelId}/play', { params: { path: { pluginId: plugin, channelId: channel.id }, query: { profile: profileId } } }),
  )
  const s = answer.source
  return { id: s.ref, provider: plugin, type: 'plugin', ref: s.ref, format: s.format, label: `${channel.number} ${channel.name}`, playable: 'yes', badges: [], notes: [] } as unknown as PlaySource
}
