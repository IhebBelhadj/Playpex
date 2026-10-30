import { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { Image } from 'expo-image'
import { LinearGradient } from 'expo-linear-gradient'
import { useQueryClient } from '@tanstack/react-query'
import Ionicons from '@expo/vector-icons/Ionicons'
import type { FilterGroup, PluginAction, PluginCall, PluginIntent, PluginRow, PluginTitleInfo, Release, ScreenMobile } from '@playpex/protocol/plugins'
import { pluginImage, runCard, screenOf, usePluginPages, usePluginScreen, usePlugins } from '../../../lib/plugins'
import { useApi, useProfile, useSession } from '../../../lib/session'
import { Action, Loading, Message, type IconName } from '../../../ui/components'
import { PluginRowView } from '../../../ui/plugin-rows'
import { Press } from '../../../ui/press'
import { Chip } from '../../../ui/section'
import { useToast } from '../../../ui/toast'
import type { Found } from '../../../core/services/releases'
import { ReleaseRow } from '../../../features/releases/ReleaseRow'
import { useDebouncedValue } from '../../../state/hooks'
import { usePlayEffect, usePlayFound } from '../../../state/playback'
import { color, fade, font, radius, space, text } from '../../../ui/theme'
import { ContentTitle, PluginBar, useChrome, type Bar } from '../../../features/plugins/PluginChrome'
import Animated from 'react-native-reanimated'

// A plugin's screen (docs/api/plugins.md): the core's template filled by the
// plugin's data handler. catalog (rows, a search, filter groups), title (its
// info, actions, rows), list (one line per item) and releases (torrents, most
// seeded first) are drawn here; guide screens are for the TV for now. The top
// is the plugin's choice for phones (features/plugins/PluginChrome.tsx).

type CatalogData = { title?: string; rows: PluginRow[]; search?: boolean; filters?: FilterGroup[]; empty?: string; mobile?: ScreenMobile }
type TitleData = { info: PluginTitleInfo; actions?: PluginAction[]; rows?: PluginRow[]; mobile?: ScreenMobile }
type ReleasesData = { title?: string; releases: Release[]; last: boolean; filters?: FilterGroup[]; empty?: string; mobile?: ScreenMobile }
type ListData = { title?: string; items: { key: string; label: string; meta?: string; icon?: string; intent?: PluginIntent; call?: PluginCall }[]; empty?: string; mobile?: ScreenMobile }

/** What every template gets: its plugin, data handler, title, params, and the manifest's choice of top */
type TemplateProps = { plugin: string; data?: string; title: string; params: Record<string, string | number>; mobile?: ScreenMobile }

export default function PluginScreen() {
  const { plugin, screen, params: rawParams } = useLocalSearchParams<{ plugin: string; screen: string; params?: string }>()
  const plugins = usePlugins()
  const decl = screenOf(plugins.data?.plugins, plugin, screen)
  const name = plugins.data?.plugins.find((p) => p.id === plugin)?.name ?? ''
  const params = useMemo(() => (rawParams ? (JSON.parse(rawParams) as Record<string, string | number>) : {}), [rawParams])

  const props = decl ? { plugin, data: decl.data, title: decl.title ?? name, params, mobile: decl.mobile as ScreenMobile | undefined } : null

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      {props && decl?.template === 'catalog' ? (
        <CatalogTemplate {...props} />
      ) : props && decl?.template === 'title' ? (
        <TitleTemplate {...props} />
      ) : props && decl?.template === 'releases' ? (
        <ReleasesTemplate {...props} />
      ) : props && decl?.template === 'list' ? (
        <ListTemplate {...props} />
      ) : (
        <Waiting>
          {plugins.isPending ? (
            <Loading />
          ) : !decl ? (
            <Message title="This screen isn’t there any more" body="The plugin may have been updated or switched off on the server." action={{ label: 'Back', onPress: () => router.back() }} />
          ) : (
            <Message icon="tv-outline" title="Open this on Playpex TV" body={`${name}’s TV guide isn’t on phones yet.`} action={{ label: 'Back', onPress: () => router.back() }} />
          )}
        </Waiting>
      )}
    </View>
  )
}

/** Before a template draws (or for one phones don't draw): the plain top */
function Waiting({ children }: { children: React.ReactNode }) {
  const chrome = useChrome('plain')
  return (
    <>
      <View style={{ flex: 1, paddingTop: chrome.top }}>{children}</View>
      <PluginBar chrome={chrome} title="" />
    </>
  )
}

/** The top this screen draws: its data answer's choice, else the manifest's, else the template's own look */
function useBar(mobile: ScreenMobile | undefined, answer: ScreenMobile | undefined, fallback: Bar = 'plain') {
  return useChrome(answer?.bar ?? mobile?.bar ?? fallback)
}

function CatalogTemplate({ plugin, data, title, params, mobile }: TemplateProps) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filters, setFilters] = useState<Record<string, string[]>>({})
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 350)
    return () => clearTimeout(timer)
  }, [query])
  const answer = usePluginScreen<CatalogData>(plugin, data, { params, query: debounced, filters }, JSON.stringify([params, debounced, filters]))
  const model = answer.data?.data
  const chrome = useBar(mobile, model?.mobile)

  function toggle(group: FilterGroup, value: string) {
    setFilters((f) => {
      const current = f[group.key] ?? []
      const on = current.includes(value)
      const next = group.multiple ? (on ? current.filter((v) => v !== value) : [...current, value]) : on ? [] : [value]
      return { ...f, [group.key]: next }
    })
  }

  return (
    <>
      <Animated.ScrollView onScroll={chrome.onScroll} scrollEventThrottle={16} contentContainerStyle={{ paddingTop: chrome.top, paddingBottom: space.xxxl }}>
        <ContentTitle chrome={chrome} title={model?.title ?? title} />
        {model?.search ? (
          <View style={styles.field}>
            <Ionicons name="search" size={18} color={color.textMuted} />
            <TextInput value={query} onChangeText={setQuery} placeholder="Search" placeholderTextColor={color.textDim} style={styles.input} cursorColor={color.accent} selectionColor={color.accent} />
          </View>
        ) : null}
        {(model?.filters ?? []).map((group) => (
          <ScrollView key={group.key} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            <Text style={[text.small, { alignSelf: 'center', marginRight: space.xs }]}>{group.label}</Text>
            {group.options.map((o) => (
              <Chip key={o.value} label={o.label} on={(filters[group.key] ?? (o.on ? [o.value] : [])).includes(o.value)} onPress={() => toggle(group, o.value)} />
            ))}
          </ScrollView>
        ))}
        <View style={{ height: space.l }} />
        {answer.isPending ? <Loading /> : null}
        {answer.isError ? <Message title={`${title} didn’t answer`} body="Try again in a moment." action={{ label: 'Try again', onPress: () => answer.refetch() }} /> : null}
        {model && !model.rows.length ? <Message title="Nothing here" body={model.empty} /> : null}
        {(model?.rows ?? []).map((row) => (
          <PluginRowView key={row.key} plugin={plugin} row={row} />
        ))}
      </Animated.ScrollView>
      <PluginBar chrome={chrome} title={model?.title ?? title} />
    </>
  )
}

function TitleTemplate({ plugin, data, params, mobile }: TemplateProps) {
  const api = useApi()
  const profile = useProfile()
  const session = useSession()
  const queryClient = useQueryClient()
  const toast = useToast()
  const play = usePlayEffect()
  const answer = usePluginScreen<TitleData>(plugin, data, { params }, JSON.stringify(params))
  const [busy, setBusy] = useState<string | null>(null)
  const model = answer.data?.data
  // Its picture goes to the top edge: Back floats over it, unless the plugin chose otherwise
  const chrome = useBar(mobile, model?.mobile, 'overlay')
  if (answer.isPending)
    return (
      <Waiting>
        <Loading />
      </Waiting>
    )
  if (!model)
    return (
      <Waiting>
        <Message title="This page didn’t load" action={{ label: 'Try again', onPress: () => answer.refetch() }} />
      </Waiting>
    )
  const info = model.info
  const backdrop = pluginImage(session, plugin, info.backdrop)
  const on = { toast: (t: string, tone?: string) => toast(t, { tone }), refresh: () => queryClient.invalidateQueries({ queryKey: ['plugins', profile.id] }), play }

  return (
    <>
      <Animated.ScrollView onScroll={chrome.onScroll} scrollEventThrottle={16} contentContainerStyle={{ paddingTop: chrome.bar === 'overlay' ? 0 : chrome.top, paddingBottom: space.xxxl }}>
        <View style={{ height: 300 }}>
          {backdrop ? <Image source={backdrop} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
          <LinearGradient colors={fade.toBg} locations={[0.3, 0.75, 1]} style={StyleSheet.absoluteFill} />
        </View>
        <View style={{ paddingHorizontal: space.l, marginTop: -space.xxxl }}>
          {info.eyebrow ? <Text style={[text.small, { color: color.accent }]}>{info.eyebrow}</Text> : null}
          <Text style={text.hero}>{info.title}</Text>
          {info.genres?.length ? <Text style={[text.small, { marginTop: space.s }]}>{info.genres.join(', ')}</Text> : null}
          {model.actions?.length ? (
            <View style={styles.actions}>
              {model.actions.map((a) => (
                <Action
                  key={a.key}
                  icon={actionIcon(a.icon)}
                  label={a.label}
                  on={a.on}
                  busy={busy === a.key}
                  onPress={() => {
                    // A plugin's call can take a while (Play searches torrent sites): the button says so
                    setBusy(a.key)
                    runCard(api, profile.id, plugin, a, on).finally(() => setBusy(null))
                  }}
                />
              ))}
            </View>
          ) : null}
          <Text style={[text.body, { marginTop: space.l }]}>{info.overview || info.overviewFallback}</Text>
          {(info.credits ?? []).map((c) => (
            <Text key={c.label} style={[text.small, { marginTop: space.s }]}>
              <Text style={{ color: color.textSecondary, fontFamily: font.semibold }}>{c.label} </Text>
              {c.names.join(', ')}
            </Text>
          ))}
        </View>
        <View style={{ marginTop: space.xxl }}>
          {(model.rows ?? []).map((row) => (
            <PluginRowView key={row.key} plugin={plugin} row={row} />
          ))}
        </View>
      </Animated.ScrollView>
      <PluginBar chrome={chrome} title={info.title} />
    </>
  )
}

/**
 * A plugin's releases: its keywords (its `q` first), its filter groups as
 * chips, most seeded first, more as you scroll; a tap plays the release with
 * nothing saved (a plugin's list names no title of the catalog).
 */
function ReleasesTemplate({ plugin, data, title, params, mobile }: TemplateProps) {
  const [query, setQuery] = useState(params.q != null ? String(params.q) : '')
  const keywords = useDebouncedValue(query.trim(), 450)
  const [filters, setFilters] = useState<Record<string, string[]>>({})
  const play = usePlayFound()
  const answer = usePluginPages<ReleasesData>(plugin, data, { params, query: keywords, filters }, JSON.stringify([params, keywords, filters]))
  const pages = answer.data?.pages ?? []
  const model = pages[0]?.data
  const chrome = useBar(mobile, model?.mobile)
  const found = pages.flatMap((p) => p.data?.releases ?? []).map((r, i) => foundOf(plugin, r, i))
  const best = Math.max(1, ...found.map((f) => f.seeds ?? 0))

  function toggle(group: FilterGroup, value: string) {
    setFilters((f) => {
      const current = f[group.key] ?? group.options.filter((o) => o.on).map((o) => o.value)
      const on = current.includes(value)
      const next = group.multiple ? (on ? current.filter((v) => v !== value) : [...current, value]) : on ? [] : [value]
      return { ...f, [group.key]: next }
    })
  }

  return (
    <>
      <Animated.FlatList
        data={found}
        keyExtractor={(f) => f.key}
        onScroll={chrome.onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingTop: chrome.top, paddingBottom: space.xxxl }}
        onEndReachedThreshold={0.6}
        onEndReached={() => answer.hasNextPage && !answer.isFetchingNextPage && answer.fetchNextPage()}
        ListHeaderComponent={
          <View style={{ marginBottom: space.l }}>
            <ContentTitle chrome={chrome} title={model?.title ?? title} size="title" />
            <View style={styles.field}>
              <Ionicons name="search" size={18} color={color.textMuted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search releases"
                placeholderTextColor={color.textDim}
                returnKeyType="search"
                autoCorrect={false}
                style={styles.input}
                cursorColor={color.accent}
                selectionColor={color.accent}
              />
            </View>
            {(model?.filters ?? []).map((group) => (
              <ScrollView key={group.key} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                <Text style={[text.small, { alignSelf: 'center', marginRight: space.xs }]}>{group.label}</Text>
                {group.options.map((o) => (
                  <Chip key={o.value} label={o.label} on={(filters[group.key] ?? (o.on ? [o.value] : [])).includes(o.value)} onPress={() => toggle(group, o.value)} />
                ))}
              </ScrollView>
            ))}
          </View>
        }
        ListEmptyComponent={
          answer.isPending ? (
            <Loading />
          ) : answer.isError ? (
            <Message title={`${title} didn’t answer`} body="Try again in a moment." action={{ label: 'Try again', onPress: () => answer.refetch() }} />
          ) : (
            <Message title="No releases found" body={model?.empty} />
          )
        }
        ListFooterComponent={
          answer.isFetchingNextPage ? (
            <View style={{ height: 120 }}>
              <Loading />
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: space.l, marginBottom: space.s }}>
            <ReleaseRow item={item} top={best} onPress={() => play(item, null)} />
          </View>
        )}
      />
      <PluginBar chrome={chrome} title={model?.title ?? title} />
    </>
  )
}

/** A plugin's release as a row of Find releases (its name: the last note, else its title) */
function foundOf(plugin: string, r: Release, i: number): Found {
  const infoHash = r.infoHash ?? /btih:([a-z0-9]+)/i.exec(r.magnet ?? '')?.[1]?.toLowerCase()
  return {
    key: `${infoHash ?? i}:${i}`,
    finder: plugin,
    kind: 'torrent',
    title: r.title,
    name: r.notes?.length ? r.notes.join(' · ') : r.title,
    year: null,
    season: null,
    episode: null,
    pack: false,
    seeds: r.seeds,
    peers: r.peers ?? null,
    size: r.size ?? null,
    quality: r.quality ?? null,
    codec: null,
    audio: null,
    matches: true,
    magnet: r.magnet,
    infoHash,
  }
}

function ListTemplate({ plugin, data, title, params, mobile }: TemplateProps) {
  const api = useApi()
  const profile = useProfile()
  const queryClient = useQueryClient()
  const toast = useToast()
  const play = usePlayEffect()
  const answer = usePluginScreen<ListData>(plugin, data, { params }, JSON.stringify(params))
  const model = answer.data?.data
  const chrome = useBar(mobile, model?.mobile)
  const on = { toast: (t: string, tone?: string) => toast(t, { tone }), refresh: () => queryClient.invalidateQueries({ queryKey: ['plugins', profile.id] }), play }
  return (
    <>
      <Animated.ScrollView onScroll={chrome.onScroll} scrollEventThrottle={16} contentContainerStyle={{ paddingTop: chrome.top, paddingBottom: space.xxxl }}>
        <ContentTitle chrome={chrome} title={model?.title ?? title} />
        {answer.isPending ? <Loading /> : null}
        {model && !model.items.length ? <Message title="Nothing here" body={model.empty} /> : null}
        {(model?.items ?? []).map((item) => (
          <Press key={item.key} onPress={() => runCard(api, profile.id, plugin, item, on)} style={styles.listItem} scale={0.98}>
            <Ionicons name={actionIcon(item.icon)} size={22} color={color.accent} />
            <View style={{ flex: 1 }}>
              <Text style={text.label}>{item.label}</Text>
              {item.meta ? <Text style={text.small}>{item.meta}</Text> : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={color.textDim} />
          </Press>
        ))}
      </Animated.ScrollView>
      <PluginBar chrome={chrome} title={model?.title ?? title} />
    </>
  )
}

// The TV's core icon names a plugin may use, drawn with this app's icons
const ICONS: Record<string, IconName> = {
  play: 'play',
  add: 'add',
  check: 'checkmark',
  heart: 'heart-outline',
  star: 'star-outline',
  folder: 'folder-outline',
  film: 'film-outline',
  tv: 'tv-outline',
  list: 'list',
  download: 'download-outline',
  link: 'link-outline',
  refresh: 'refresh',
  search: 'search',
  settings: 'settings-outline',
  info: 'information-circle-outline',
}

function actionIcon(icon: string | undefined): IconName {
  return (icon && ICONS[icon]) || 'ellipse-outline'
}

const styles = StyleSheet.create({
  pageTitle: { paddingHorizontal: space.l, marginBottom: space.l },
  field: {
    marginHorizontal: space.l,
    marginBottom: space.m,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s,
    backgroundColor: color.surface2,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    paddingHorizontal: space.l,
    height: 46,
  },
  input: { flex: 1, color: color.text, fontFamily: font.medium, fontSize: 15, paddingVertical: 0 },
  chips: { paddingHorizontal: space.l, gap: space.s, paddingVertical: space.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s, marginTop: space.l },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.m,
    paddingHorizontal: space.l,
    paddingVertical: space.m,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
})
