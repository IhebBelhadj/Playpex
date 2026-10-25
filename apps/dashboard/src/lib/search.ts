import { useQueries, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, unwrap, type Schemas } from '@/lib/api'

// Search (docs/search-plan.md): what one field reaches. Every source answers
// on its own (a slow site never holds the others back); each says how it went.
//
//   useSearchSources(kind)          who can be asked: stream plugins, release providers, live plugins
//   usePaged(key, sources, fetch)   every source at once, page 1, then more pages on demand, per source
//   useCatalogSearch / useLiveSearch
//   isLink(text)                    a URL, a magnet or an info hash: read it instead of searching

export type SearchKind = 'all' | 'movie' | 'tv'
export type Release = Schemas['ReleaseTorrent']
export type StreamItem = Schemas['SearchSource']
export type CatalogTitle = Schemas['CatalogTitle']
export type LiveChannel = Schemas['LiveChannel'] & { plugin: string }

/** A source of one group, as the sources line and the rail name it */
export type Source = { id: string; name: string; group: 'streams' | 'torrents' | 'live' }

export type SourceState = {
  source: Source
  state: 'idle' | 'searching' | 'done' | 'failed'
  count: number
  loose: number
  error: unknown
}

export function isLink(text: string) {
  const t = text.trim()
  return /^(https?:\/\/|magnet:\?)/i.test(t) || /^[0-9a-f]{40}$/i.test(t)
}

/** Who can be asked for a kind: release providers (both kinds for everything), stream plugins, live plugins (everything only) */
export function useSearchSources(kind: SearchKind) {
  const movie = useQuery({
    queryKey: ['release-providers', 'movie'],
    queryFn: () => unwrap(api.GET('/releases/providers', { params: { query: { kind: 'movie' } } })),
    staleTime: 60_000,
  })
  const tv = useQuery({
    queryKey: ['release-providers', 'tv'],
    queryFn: () => unwrap(api.GET('/releases/providers', { params: { query: { kind: 'tv' } } })),
    staleTime: 60_000,
  })
  const streams = useQuery({ queryKey: ['search-providers'], queryFn: () => unwrap(api.GET('/search/providers')), staleTime: 60_000 })
  const live = useQuery({ queryKey: ['live'], queryFn: () => unwrap(api.GET('/live')), staleTime: 60_000 })

  const torrentKinds: ('movie' | 'tv')[] = kind === 'all' ? ['movie', 'tv'] : [kind]
  const byId = new Map<string, { id: string; name: string; kinds: ('movie' | 'tv')[] }>()
  for (const k of torrentKinds) {
    for (const p of (k === 'movie' ? movie.data : tv.data) ?? []) {
      const known = byId.get(p.id)
      if (known) known.kinds.push(k)
      else byId.set(p.id, { id: p.id, name: p.name, kinds: [k] })
    }
  }
  const liveProviders = live.data?.providers ?? []
  return {
    pending: movie.isPending || tv.isPending || streams.isPending || live.isPending,
    torrents: [...byId.values()],
    streams: streams.data ?? [],
    live: kind === 'all' ? liveProviders : [],
  }
}

/**
 * Every source asked at once for `key` (a new key starts again at page 1); a
 * source's next page on demand. `fetch` answers a page's items and whether
 * there is more; items are merged in source order, `id` deduping them.
 */
export function usePaged<T>(
  key: unknown[],
  sources: { id: string }[],
  fetch: (sourceId: string, page: number) => Promise<{ items: T[]; hasMore: boolean }>,
  id: (item: T) => string,
  enabled: boolean,
) {
  const keyText = JSON.stringify(key)
  const [pages, setPages] = useState<{ key: string; pages: Record<string, number> }>({ key: '', pages: {} })
  const read = pages.key === keyText ? pages.pages : {}
  const plan = sources.flatMap((s) => Array.from({ length: read[s.id] ?? 1 }, (_, i) => ({ source: s.id, page: i + 1 })))
  const queries = useQueries({
    queries: plan.map(({ source, page }) => ({
      queryKey: [...key, source, page],
      enabled,
      staleTime: 5 * 60_000,
      retry: false,
      queryFn: () => fetch(source, page),
    })),
  })
  const seen = new Map<string, T>()
  const from = new Map<string, string>()
  queries.forEach((x, i) => {
    for (const item of x.data?.items ?? []) {
      const k = id(item)
      if (!seen.has(k)) {
        seen.set(k, item)
        from.set(k, plan[i].source)
      }
    }
  })
  const states = sources.map((s) => {
    const mine = queries.filter((_, i) => plan[i].source === s.id)
    return {
      id: s.id,
      searching: mine.some((x) => x.isFetching),
      error: mine.find((x) => x.error)?.error ?? null,
      items: [...seen.entries()].filter(([k]) => from.get(k) === s.id).map(([, v]) => v),
    }
  })
  const more = sources.filter((s) => queries[plan.findLastIndex((x) => x.source === s.id)]?.data?.hasMore)
  return {
    items: [...seen.values()],
    states,
    searching: queries.some((x) => x.isFetching),
    hasMore: more.length > 0,
    loadMore: () => setPages({ key: keyText, pages: Object.fromEntries(sources.map((s) => [s.id, (read[s.id] ?? 1) + (more.includes(s) ? 1 : 0)])) }),
  }
}

/** Torrents from every release provider of the kind(s); everything asks both kinds and merges them */
export function useTorrentSearch(kind: SearchKind, q: string, sources: { id: string; kinds: ('movie' | 'tv')[] }[]) {
  return usePaged<Release>(
    ['release-search', kind, q],
    sources,
    async (id, page) => {
      const kinds = sources.find((s) => s.id === id)?.kinds ?? []
      const answers = await Promise.all(kinds.map((k) => unwrap(api.GET('/releases/browse', { params: { query: { kind: k, provider: id, q, page } } }))))
      return { items: answers.flatMap((a) => a.torrents), hasMore: answers.some((a) => a.hasMore) }
    },
    (t) => t.hash,
    !!q,
  )
}

/** Streams and files from the plugins with sources.search */
export function useStreamSearch(kind: SearchKind, q: string, sources: { id: string }[]) {
  const asked = kind === 'tv' ? 'show' : kind === 'movie' ? 'movie' : 'any'
  return usePaged<StreamItem>(
    ['stream-search', asked, q],
    sources,
    async (id, page) => {
      const answer = await unwrap(api.GET('/search/sources', { params: { query: { provider: id, q, kind: asked, page } } }))
      return { items: answer.items, hasMore: answer.hasMore }
    },
    (s) => s.ref ?? s.infoHash ?? s.label,
    !!q,
  )
}

/** Movies and shows from the catalog (TMDB behind the server) */
export function useCatalogSearch(kind: SearchKind, q: string) {
  return useQuery({
    queryKey: ['catalog-search', kind, q],
    enabled: !!q,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const answer = await unwrap(api.GET('/catalog/search/{kind}', { params: { path: { kind: kind === 'all' ? 'multi' : kind }, query: { q } } }))
      return (answer.results as (CatalogTitle | { mediaType: 'person' })[]).filter((r): r is CatalogTitle => r.mediaType === 'movie' || r.mediaType === 'tv')
    },
  })
}

/** Channels of every live plugin whose name, number or group starts with the words */
export function useLiveSearch(q: string, providers: { plugin: string; name: string }[]) {
  return usePaged<LiveChannel>(
    ['live-search', q],
    providers.map((p) => ({ id: p.plugin })),
    async (plugin) => {
      const answer = await unwrap(api.GET('/live/{pluginId}/channels', { params: { path: { pluginId: plugin }, query: { q } } }))
      return { items: answer.channels.slice(0, 60).map((c) => ({ ...c, plugin })), hasMore: false }
    },
    (c) => `${c.plugin}:${c.id}`,
    !!q,
  )
}

/** Lower case, accents off, letters and digits only: "Spider-Man" and "spiderman" meet */
export function squash(text: string) {
  return text.toLocaleLowerCase().normalize('NFD').replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Every word of q somewhere in the text, however it's spelt (the dashboard's own lists: library, downloads) */
export function holds(text: string, q: string) {
  const name = squash(text)
  return q.split(/\s+/).map(squash).filter(Boolean).every((w) => name.includes(w))
}
