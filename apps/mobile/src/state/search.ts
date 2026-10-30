import { keepPreviousData, useMutation, useQueries, useQuery } from '@tanstack/react-query'
import { PlaybackSession } from '../core/playback/session'
import { titlesOf } from '../core/services/catalog'
import type { Found } from '../core/services/releases'
import {
  channelSource,
  inspectLink,
  linkSource,
  liveProviders,
  looseTitle,
  searchChannels,
  searchStreams,
  searchTorrents,
  streamProviders,
  torrentProviders,
  type LinkItem,
  type LiveChannel,
} from '../core/services/search'
import { unwrap } from '../core/http/api'
import { useApp, useClient, useProfile } from './app'
import { pushPlayer } from './navigation'

// Search's data (core/services/search.ts): each group asked for once the
// words settle, every provider on its own (a slow one never holds the others
// back), and what a result does when tapped: it plays, saved for no title.

const MINUTE = 60 * 1000

/** Movies and shows of the catalog */
export function useTitleResults(q: string) {
  const client = useClient()
  const answer = useQuery({
    queryKey: ['catalog', 'search', q],
    queryFn: () => unwrap(client.api.GET('/catalog/search/{kind}', { params: { path: { kind: 'multi' }, query: { q } } })),
    enabled: q.length > 1,
    placeholderData: keepPreviousData,
    staleTime: 10 * MINUTE,
  })
  return { titles: titlesOf(answer.data), loading: answer.isFetching && !answer.data }
}

export type Group<T> = { provider: string; name: string; items: T[]; loading: boolean; error: string | null }

/** Plugins' streams and files for the words, per provider */
export function useStreamResults(q: string, enabled: boolean): Group<Found>[] {
  const client = useClient()
  const providers = useQuery({ queryKey: ['search', 'providers', 'streams'], queryFn: () => streamProviders(client), staleTime: 10 * MINUTE })
  const results = useQueries({
    queries: (providers.data ?? []).map((p) => ({
      queryKey: ['search', 'streams', p.id, q],
      queryFn: () => searchStreams(client, p.id, q),
      enabled: enabled && q.length > 1,
      staleTime: 5 * MINUTE,
    })),
  })
  return (providers.data ?? []).map((p, i) => groupOf(p.id, p.name, results[i]))
}

/** The release providers' torrents for the words, per provider */
export function useTorrentResults(q: string, enabled: boolean): Group<Found>[] {
  const client = useClient()
  const providers = useQuery({ queryKey: ['search', 'providers', 'torrents'], queryFn: () => torrentProviders(client), staleTime: 10 * MINUTE })
  const results = useQueries({
    queries: (providers.data ?? []).map((p) => ({
      queryKey: ['search', 'torrents', p.id, q],
      queryFn: () => searchTorrents(client, p, q),
      enabled: enabled && q.length > 1,
      staleTime: 5 * MINUTE,
    })),
  })
  return (providers.data ?? []).map((p, i) => groupOf(p.id, p.name, results[i]))
}

/** Live plugins' channels whose name, number or group holds the words */
export function useChannelResults(q: string, enabled: boolean): Group<LiveChannel>[] {
  const client = useClient()
  const profile = useProfile()
  const providers = useQuery({ queryKey: ['search', 'providers', 'live', profile.id], queryFn: () => liveProviders(client, profile.id), staleTime: 10 * MINUTE })
  const results = useQueries({
    queries: (providers.data ?? []).map((p) => ({
      queryKey: ['search', 'channels', profile.id, p.plugin, q],
      queryFn: () => searchChannels(client, p.plugin, q, profile.id),
      enabled: enabled && q.length > 1,
      staleTime: 5 * MINUTE,
    })),
  })
  return (providers.data ?? []).map((p, i) => groupOf(p.plugin, p.name, results[i]))
}

function groupOf<T>(provider: string, name: string, r: { data?: T[]; isFetching: boolean; error: Error | null } | undefined): Group<T> {
  return { provider, name, items: r?.data ?? [], loading: !!r?.isFetching && !r?.data, error: r?.error ? r.error.message : null }
}

/** A pasted link, read by the server when asked (Enter, or Open) */
export function useLinkReader() {
  const client = useClient()
  const profile = useProfile()
  return useMutation({ mutationFn: (text: string) => inspectLink(client, text, profile.id) })
}

/** What a tap on a result does: it plays in the player, as nothing of the catalog (nothing saved) */
export function usePlayAnything() {
  const client = useClient()
  const profile = useProfile()
  const { playbacks } = useApp()
  const open = (label: string, source: ReturnType<typeof linkSource>, year: number | null = null) => {
    const session = new PlaybackSession({ client, profileId: profile.id, title: looseTitle(label, year), source, startAt: 0, tracking: 'none' })
    pushPlayer(playbacks.add(session))
  }
  return {
    link: (item: LinkItem) => open(item.label, linkSource(item)),
    channel: async (plugin: string, channel: LiveChannel) => open(`${channel.number} ${channel.name}`, await channelSource(client, plugin, channel, profile.id)),
  }
}
