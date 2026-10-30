import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import type { DataAnswer, Effect, PluginCall, PluginCard, PluginIntent, PluginRow } from '@playpex/protocol/plugins'
import { API_PREFIX, authHeaders, unwrap, type Api, type Schemas } from './api'
import type { PlaySource, PlayTitle } from '../core/services/playback'
import { useApi, useProfile } from './session'

// The server's plugins as this phone draws them (docs/api/plugins.md): never
// their code, only what they answer. Their sections open plugin screens (the
// catalog template here), their slots add rows to the core's screens, and a
// card's intent or call is performed with the effects it answers.

export type ClientPlugin = Schemas['ClientPlugin']
export type SlotName = 'core.movies.rows' | 'core.shows.rows' | 'core.movie.rows' | 'core.show.rows' | 'core.watchlist.rows'

export function usePlugins() {
  const api = useApi()
  const profile = useProfile()
  return useQuery({
    queryKey: ['plugins', profile.id],
    queryFn: () => unwrap(api.GET('/plugins', { params: { query: { profile: profile.id } } })),
    staleTime: 10 * 60 * 1000,
  })
}

/** Whether some plugin of this profile lists releases (`GET /plugins` capabilities): without one, Find releases is hidden */
export function useCanFindReleases(): boolean {
  return usePlugins().data?.capabilities?.releases ?? false
}

/** Whether some plugin of this profile finds a title's sources (`play.collect`): without one, Play only has the server's files */
export function useHasSourcePlugins(): boolean {
  return usePlugins().data?.capabilities?.sources ?? false
}

export function askPlugin<T>(api: Api, profileId: string, plugin: string, name: string, args: Record<string, unknown>) {
  return unwrap(
    api.POST('/plugins/{pluginId}/data/{name}', {
      params: { path: { pluginId: plugin, name }, query: { profile: profileId } },
      body: { args } as never,
    }),
  ) as Promise<DataAnswer<T>>
}

/**
 * A plugin's image: a full URL, or a file of its package (`assets/…`), which
 * the server serves only to a paired device: those go with this phone's token.
 */
export function pluginImage(session: { server: { url: string; token: string | null } | null; deviceId: string }, plugin: string, path: string | null | undefined) {
  if (!path || !session.server) return undefined
  if (/^https?:\/\//.test(path)) return path.startsWith(session.server.url) ? { uri: path, headers: authHeaders(session.server.token, session.deviceId) } : { uri: path }
  return { uri: `${session.server.url}${API_PREFIX}/plugins/${plugin}/${path}`, headers: authHeaders(session.server.token, session.deviceId) }
}

export type SlotRow = PluginRow & { plugin: string }

/** Every enabled plugin's rows for a slot of a core screen, in their order */
export function useSlotRows(slot: SlotName, context: Record<string, unknown>, contextKey: string) {
  const api = useApi()
  const profile = useProfile()
  const plugins = usePlugins()
  const contributions = (plugins.data?.plugins ?? []).flatMap((p) =>
    (p.slots ?? []).filter((s) => s.slot === slot).map((s) => ({ plugin: p.id, data: s.data, order: s.order ?? 0 })),
  )
  return useQuery({
    queryKey: ['plugins', profile.id, 'slot', slot, contextKey, contributions.map((c) => c.plugin + c.data).join()],
    enabled: contributions.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const answers = await Promise.all(
        contributions
          .sort((a, b) => a.order - b.order)
          .map((c) =>
            askPlugin<PluginRow[]>(api, profile.id, c.plugin, c.data, { slot, context })
              .then((a) => (a.data ?? []).map((row) => ({ ...row, plugin: c.plugin })))
              .catch(() => [] as SlotRow[]),
          ),
      )
      return answers.flat()
    },
  })
}

/** A plugin's chip on the Search page (slot core.search.filters) and, for the words, its rows */
export type SearchChip = { key: string; label: string; plugin: string; rows: PluginRow[]; loading: boolean }

/**
 * The plugins' chips of the Search page (docs/plugins/tv.md, slot `core.search.filters`): each
 * contribution asked with the words ({ slot, context: { query } }); its answer names the chip and
 * holds its results, shown only when the chip is chosen. The server lists only the plugins this
 * profile may use (a kids profile gets no adults plugin).
 */
export function useSearchChips(query: string): SearchChip[] {
  const api = useApi()
  const profile = useProfile()
  const plugins = usePlugins()
  const slot = 'core.search.filters'
  const contributions = (plugins.data?.plugins ?? []).flatMap((p) =>
    (p.slots ?? []).filter((s) => s.slot === slot).map((s) => ({ plugin: p.id, name: p.name, data: s.data, order: s.order ?? 0 })),
  )
  contributions.sort((a, b) => a.order - b.order)
  const answers = useQuery({
    queryKey: ['plugins', profile.id, 'slot', slot, query, contributions.map((c) => c.plugin + c.data).join()],
    enabled: contributions.length > 0 && query.length > 1,
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      Promise.all(
        contributions.map((c) =>
          askPlugin<{ chip: { key: string; label: string }; rows: PluginRow[] }>(api, profile.id, c.plugin, c.data, { slot, context: { query } })
            .then((a) => a.data ?? null)
            .catch(() => null),
        ),
      ),
  })
  return contributions.map((c, i) => {
    const answer = answers.data?.[i]
    return { key: `${c.plugin}:${c.data}`, label: answer?.chip.label ?? c.name, plugin: c.plugin, rows: answer?.rows ?? [], loading: answers.isFetching && !answers.data }
  })
}

/** A plugin screen's data (`POST /plugins/{id}/data/{name}` with its template's args) */
export function usePluginScreen<T>(plugin: string, data: string | undefined, args: Record<string, unknown>, argsKey: string) {
  const api = useApi()
  const profile = useProfile()
  return useQuery({
    queryKey: ['plugins', profile.id, 'screen', plugin, data, argsKey],
    enabled: !!data,
    queryFn: () => askPlugin<T>(api, profile.id, plugin, data!, args),
  })
}

/** A paged plugin screen (releases): `page` 1, 2… until an answer says `last` */
export function usePluginPages<T extends { last: boolean }>(plugin: string, data: string | undefined, args: Record<string, unknown>, argsKey: string) {
  const api = useApi()
  const profile = useProfile()
  return useInfiniteQuery({
    queryKey: ['plugins', profile.id, 'pages', plugin, data, argsKey],
    enabled: !!data,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => askPlugin<T>(api, profile.id, plugin, data!, { ...args, page: pageParam }),
    getNextPageParam: (last, pages) => (last.data?.last ? undefined : pages.length + 1),
  })
}

export function screenOf(plugins: ClientPlugin[] | undefined, plugin: string, name: string) {
  return plugins?.find((p) => p.id === plugin)?.screens?.find((s) => s.name === name)
}

/** Opens an intent: a core title, or one of the plugin's screens */
export function openIntent(plugin: string, intent: PluginIntent) {
  const params = intent.params ?? {}
  const go = intent.replace ? router.replace : router.push
  if (intent.screen === 'core.movie' || intent.screen === 'core.show') {
    const id = params.id ?? params.tmdbId
    if (id == null) return
    go({ pathname: '/title/[mediaType]/[id]', params: { mediaType: intent.screen === 'core.movie' ? 'movie' : 'tv', id: String(id) } })
    return
  }
  if (intent.screen === 'core.search') {
    go({ pathname: '/search', params: params.query ? { q: String(params.query) } : {} })
    return
  }
  const match = /^plugin\.([a-z][a-z0-9-]*)\.([A-Za-z0-9]+)$/.exec(intent.screen)
  if (!match) return
  go({ pathname: '/plugin/[plugin]/[screen]', params: { plugin: match[1], screen: match[2], params: JSON.stringify(params) } })
}

export type EffectHandlers = {
  toast: (text: string, tone?: string) => void
  refresh: () => void
  /** A play effect's first source, in the player (state/playback.tsx usePlayEffect) */
  play: (title: PlayTitle, source: PlaySource, tracking: 'full' | 'none') => void
}

/** Performs what a plugin answered: open, play, toast, refresh; confirm and download need the dashboard's flows here */
export async function perform(api: Api, profileId: string, plugin: string, effects: Effect[] | undefined, on: EffectHandlers) {
  for (const effect of effects ?? []) {
    if (effect.type === 'open') openIntent(plugin, effect.intent)
    else if (effect.type === 'toast') on.toast(effect.text, effect.tone)
    else if (effect.type === 'refresh') on.refresh()
    else if (effect.type === 'play') playEffect(plugin, effect.request, on)
    else if (effect.type === 'confirm' && effect.then.type === 'call') {
      // A phone answers "yes" by tapping again: the question is shown, the call waits
      on.toast(effect.question)
    } else if (effect.type === 'confirm') await perform(api, profileId, plugin, [effect.then as Effect], on)
  }
}

export async function runCard(api: Api, profileId: string, plugin: string, card: { intent?: PluginIntent; call?: PluginCall }, on: EffectHandlers) {
  if (card.intent) return openIntent(plugin, card.intent)
  if (!card.call) return
  try {
    const answer = await askPlugin(api, profileId, plugin, card.call.data, card.call.args ?? {})
    await perform(api, profileId, plugin, answer.effects, on)
  } catch {
    on.toast('The plugin didn’t answer.', 'error')
  }
}

type PlayEffect = Extract<Effect, { type: 'play' }>['request']

function playEffect(plugin: string, request: PlayEffect, on: EffectHandlers) {
  const ref = request.ref
  const title: PlayTitle = {
    mediaType: ref?.kind === 'show' || ref?.kind === 'episode' ? 'tv' : 'movie',
    tmdbId: ref?.tmdbId ?? 0,
    imdbId: ref?.imdbId ?? null,
    title: request.title,
    year: null,
    season: ref?.season,
    episode: ref?.episode,
    posterPath: null,
    backdropPath: null,
  }
  const sources = request.sources.map((s, i) => toPlaySource(plugin, s as PluginPlaySource, i)).filter((s): s is PlaySource => !!s)
  if (!sources.length) return
  on.play(title, sources[0], request.tracking ?? 'full')
}

// What a play effect's sources are once the server checked them: a torrent, or a media ref it proxies
type PluginPlaySource = { kind: 'magnet'; magnet?: string; infoHash?: string; label?: string } | { kind: 'media'; ref: string; format?: string; label?: string }

function toPlaySource(plugin: string, s: PluginPlaySource, i: number): PlaySource | null {
  const base = { provider: plugin, plugin, label: s.label ?? 'Plugin', playable: 'yes' as const, badges: [], notes: [] }
  if (s.kind === 'magnet' && (s.magnet || s.infoHash)) {
    return { ...base, id: `torrent:${s.infoHash ?? i}`, type: 'torrent', magnet: s.magnet, infoHash: s.infoHash } as PlaySource
  }
  if (s.kind === 'media') return { ...base, id: s.ref, type: 'plugin', ref: s.ref, format: s.format as PlaySource['format'] } as PlaySource
  return null
}

export type { PluginCard, PluginRow }
