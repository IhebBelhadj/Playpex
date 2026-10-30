import { useState, type ReactNode } from 'react'
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Image } from 'expo-image'
import Ionicons from '@expo/vector-icons/Ionicons'
import { formatSize } from '../../core/services/playback'
import type { Found } from '../../core/services/releases'
import { isLink, normalizeLink, type LinkInspection, type LinkItem, type LiveChannel } from '../../core/services/search'
import { useCatalogList } from '../../lib/catalog'
import { useSearchChips, type SearchChip } from '../../lib/plugins'
import { PluginRowView } from '../../ui/plugin-rows'
import { titlesOf } from '../../lib/recommend'
import { useBackPress, useDebouncedValue } from '../../state/hooks'
import { usePlayFound } from '../../state/playback'
import { useChannelResults, useLinkReader, usePlayAnything, useStreamResults, useTitleResults, useTorrentResults, type Group } from '../../state/search'
import { IconButton, ROW_LIST, TitleCard, type IconName } from '../../ui/components'
import { Press } from '../../ui/press'
import { useToast } from '../../ui/toast'
import { color, font, radius, space, text } from '../../ui/theme'
import { ReleaseRow } from '../releases/ReleaseRow'
import { RefineSheet } from './RefineSheet'
import { CODECS, NO_REFINE, QUALITIES, SIZES, SORTS, WHATS, refine, refineCount, toggle, type Refine } from '../../core/search/refine'

// Search: one field for everything the server reaches, as the dashboard's
// Search (docs/search-plan.md). Words find movies and shows of the catalog,
// the plugins' videos of any kind (films, clips, talks: whatever their
// providers have), torrents and live channels, each group on its own as its
// providers answer; the chips narrow it to one kind. A pasted link (a page, a
// video, a playlist, a magnet) is read by the server, and what it holds plays.

/** A kind of result, or a plugin's chip (`plugin:<its key>`) */
type Scope = 'all' | 'titles' | 'videos' | 'torrents' | 'channels' | `plugin:${string}`

/** Rows of a group shown before "Show all" */
const FIRST = 5

export default function SearchScreen() {
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ q?: string }>()
  const [input, setInput] = useState(params.q ?? '')
  const [scope, setScope] = useState<Scope>('all')
  const [refines, setRefines] = useState<{ videos: Refine; torrents: Refine }>({ videos: NO_REFINE, torrents: NO_REFINE })
  const [sheet, setSheet] = useState<'videos' | 'torrents' | null>(null)
  useBackPress(sheet != null, () => setSheet(null))
  const q = useDebouncedValue(input.trim(), 350)
  const link = isLink(input)
  const reader = useLinkReader()
  const searching = q.length > 1 && !link

  const titles = useTitleResults(searching && (scope === 'all' || scope === 'titles') ? q : '')
  const videos = useStreamResults(q, searching && scope !== 'titles' && scope !== 'channels')
  const torrents = useTorrentResults(q, searching && (scope === 'all' || scope === 'torrents'))
  const channels = useChannelResults(q, searching && (scope === 'all' || scope === 'channels'))

  // Stream plugins find torrents too: those join the torrents, Videos keep files and streams
  const videoGroups = videos.map((g) => ({ ...g, items: g.items.filter((f) => f.kind !== 'torrent') }))
  const torrentGroups = [...torrents, ...videos.map((g) => ({ ...g, items: g.items.filter((f) => f.kind === 'torrent') }))]
  // Plugins' chips (slot core.search.filters): their results show only when one is chosen
  const chips = useSearchChips(searching ? q : '')
  const chip = chips.find((c) => `plugin:${c.key}` === scope) ?? null
  const scopes: { key: Scope; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'titles', label: 'Movies & shows' },
    ...(videos.length ? [{ key: 'videos' as const, label: 'Videos' }] : []),
    ...(torrentGroups.length ? [{ key: 'torrents' as const, label: 'Torrents' }] : []),
    ...(channels.length ? [{ key: 'channels' as const, label: 'Channels' }] : []),
    ...chips.map((c) => ({ key: `plugin:${c.key}` as Scope, label: c.label })),
  ]
  const read = () => {
    if (isLink(input)) reader.mutate(input)
  }
  const shown = reader.data && reader.variables === input ? reader.data : null

  return (
    <View style={{ flex: 1, backgroundColor: color.bg, paddingTop: insets.top + space.m }}>
      <View style={styles.field}>
        <Ionicons name={link ? 'link' : 'search'} size={20} color={link ? color.accent : color.textMuted} />
        <TextInput
          value={input}
          onChangeText={(t) => {
            setInput(t)
            reader.reset()
          }}
          onSubmitEditing={read}
          placeholder="Titles, videos or a link"
          placeholderTextColor={color.textDim}
          returnKeyType={link ? 'go' : 'search'}
          autoCorrect={false}
          autoCapitalize="none"
          selectionColor={color.accent}
          cursorColor={color.accent}
          style={styles.input}
        />
        {input ? (
          <IconButton
            icon="close-circle"
            size={20}
            label="Clear"
            onPress={() => {
              setInput('')
              reader.reset()
            }}
          />
        ) : null}
      </View>

      {link ? (
        <LinkView text={input} reading={reader.isPending} error={reader.error?.message ?? null} answer={shown} onRead={read} />
      ) : searching ? (
        <ScrollView keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: space.xxxl + 64 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scopes} keyboardShouldPersistTaps="handled">
            {scopes.map((s) => (
              <Press key={s.key} onPress={() => setScope(s.key)} scale={0.95} style={[styles.scope, scope === s.key && styles.scopeOn]} accessibilityRole="tab" accessibilityState={{ selected: scope === s.key }}>
                <Text style={[styles.scopeLabel, scope === s.key && styles.scopeLabelOn]}>{s.label}</Text>
              </Press>
            ))}
          </ScrollView>
          {scope === 'all' || scope === 'titles' ? <TitlesSection q={q} titles={titles.titles} loading={titles.loading} grid={scope === 'titles'} /> : null}
          {scope === 'all' || scope === 'videos' ? <FoundSection
              title="Videos"
              groups={videoGroups}
              q={q}
              refined={scope === 'videos'}
              value={refines.videos}
              onRefine={() => setSheet('videos')}
              onChange={(v) => setRefines({ ...refines, videos: v })}
              onSeeAll={() => setScope('videos')}
            /> : null}
          {scope === 'all' || scope === 'torrents' ? <FoundSection
              title="Torrents"
              groups={torrentGroups}
              q={q}
              refined={scope === 'torrents'}
              value={refines.torrents}
              onRefine={() => setSheet('torrents')}
              onChange={(v) => setRefines({ ...refines, torrents: v })}
              onSeeAll={() => setScope('torrents')}
            /> : null}
          {scope === 'all' || scope === 'channels' ? <ChannelSection groups={channels} q={q} all={scope === 'channels'} /> : null}
          {chip ? <ChipResults chip={chip} q={q} /> : null}
        </ScrollView>
      ) : (
        <Trending />
      )}
      {sheet && searching ? (
        <RefineSheet
          noun={sheet}
          items={merged(sheet === 'videos' ? videoGroups : torrentGroups)}
          value={refines[sheet]}
          sources={new Map((sheet === 'videos' ? videoGroups : torrentGroups).map((g) => [g.provider, g.name]))}
          onChange={(v) => setRefines({ ...refines, [sheet]: v })}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </View>
  )
}

/** Before anything is typed: what is trending, and what else the field takes */
function Trending() {
  const { width } = useWindowDimensions()
  const trending = useCatalogList('movie', 'trending')
  const columns = Math.max(3, Math.floor((width - space.l * 2) / 120))
  const tile = (width - space.l * 2 - space.s * (columns - 1)) / columns
  return (
    <FlatList
      key={columns}
      data={titlesOf(trending.data?.results)}
      numColumns={columns}
      keyExtractor={(t) => t.mediaType + t.tmdbId}
      keyboardDismissMode="on-drag"
      removeClippedSubviews={false}
      ListHeaderComponent={
        <>
          <Text style={styles.hint}>Search the catalog and your server’s plugins, or paste a link to a video, a page or a magnet.</Text>
          <Text style={[text.heading, styles.heading]}>Trending this week</Text>
        </>
      }
      contentContainerStyle={{ paddingHorizontal: space.l, paddingBottom: space.xxxl + 64, gap: space.l }}
      columnWrapperStyle={{ gap: space.s }}
      renderItem={({ item }) => <TitleCard title={item} width={tile} scope="search" />}
    />
  )
}

function Section({ title, count, loading, children }: { title: string; count?: number; loading?: boolean; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={text.heading}>{title}</Text>
        {loading ? <ActivityIndicator size="small" color={color.textMuted} /> : count ? <Text style={styles.count}>{count}</Text> : null}
      </View>
      {children}
    </View>
  )
}

function TitlesSection({ q, titles, loading, grid }: { q: string; titles: ReturnType<typeof useTitleResults>['titles']; loading: boolean; grid: boolean }) {
  const { width } = useWindowDimensions()
  const tile = (width - space.l * 2 - space.s * 2) / 3
  if (!loading && !titles.length) return <Section title="Movies & shows"><Empty>Nothing in the catalog matches “{q}”.</Empty></Section>
  return (
    <Section title="Movies & shows" loading={loading}>
      {grid ? (
        <View style={styles.grid}>
          {titles.map((t) => (
            <TitleCard key={t.mediaType + t.tmdbId} title={t} width={tile} scope="search" />
          ))}
        </View>
      ) : (
        <FlatList
          {...ROW_LIST}
          horizontal
          data={titles}
          keyExtractor={(t) => t.mediaType + t.tmdbId}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
          renderItem={({ item }) => <TitleCard title={item} scope="search" />}
        />
      )}
    </Section>
  )
}

/** One row per torrent, whoever found it */
function merged(groups: Group<Found>[]): Found[] {
  const seen = new Set<string>()
  return groups.flatMap((g) => g.items).filter((f) => !f.infoHash || (!seen.has(f.infoHash.toLowerCase()) && !!seen.add(f.infoHash.toLowerCase())))
}

/** Rows drawn at a time in a whole list ("Show more" for the next ones) */
const PAGE = 30

/**
 * Videos or torrents. Under All: the five best (names holding every word, then the most seeded) and
 * "Show all", which opens the kind. Opened: the order and filters (RefineSheet), the ones on as chips
 * that remove them, the list as refined.
 */
function FoundSection({ title, groups, q, refined, value, onRefine, onChange, onSeeAll }: {
  title: string
  groups: Group<Found>[]
  q: string
  /** Opened (the scope is this kind): its order and filters apply */
  refined: boolean
  value: Refine
  onRefine: () => void
  onChange: (value: Refine) => void
  onSeeAll: () => void
}) {
  const play = usePlayFound()
  const [limit, setLimit] = useState(PAGE)
  if (!groups.length) return null
  const loading = groups.some((g) => g.loading)
  const names = new Map(groups.map((g) => [g.provider, g.name]))
  const all = merged(groups)
  const items = refine(all, refined ? value : NO_REFINE)
  const shown = refined ? items.slice(0, limit) : items.slice(0, FIRST)
  const best = Math.max(1, ...items.map((f) => f.seeds ?? 0))
  const failed = groups.filter((g) => g.error).map((g) => g.name)
  const on = refineCount(value)
  const noun = title.toLowerCase()
  return (
    <Section title={title} count={refined ? undefined : all.length} loading={loading}>
      {refined ? (
        <View style={styles.tools}>
          <Text style={styles.toolsCount}>{on ? `${items.length.toLocaleString()} of ${all.length.toLocaleString()} ${noun}` : `${all.length.toLocaleString()} ${noun}`}</Text>
          <Press onPress={onRefine} scale={0.95} style={[styles.tool, on > 0 && styles.toolOn]} accessibilityRole="button" accessibilityLabel={`Sort and filter, ${on} filters on`}>
            <Ionicons name="options-outline" size={17} color={on ? color.accent : color.text} />
            <Text style={styles.toolLabel}>{SORTS.find((x) => x.value === value.sort)!.label}</Text>
            {on ? (
              <View style={styles.badge}>
                <Text style={styles.badgeLabel}>{on}</Text>
              </View>
            ) : null}
          </Press>
        </View>
      ) : null}
      {refined && on ? <ActiveFilters value={value} sources={names} onChange={onChange} /> : null}
      {shown.map((item) =>
        item.kind === 'torrent' ? (
          <View key={item.finder + item.key} style={styles.item}>
            <ReleaseRow item={item} top={best} onPress={() => play(item, null)} />
          </View>
        ) : (
          <VideoRow key={item.finder + item.key} item={item} from={names.get(item.finder) ?? ''} onPress={() => play(item, null)} />
        ),
      )}
      {!loading && !all.length ? <Empty>No {noun} for “{q}”.</Empty> : null}
      {!loading && all.length && !items.length ? <Empty>None of the {all.length} {noun} fits these filters.</Empty> : null}
      {!refined && items.length > FIRST ? <More label={`Show all ${items.length}`} onPress={onSeeAll} /> : null}
      {refined && items.length > limit ? <More label={`Show ${Math.min(PAGE, items.length - limit)} more`} onPress={() => setLimit(limit + PAGE)} /> : null}
      {failed.length ? <Text style={styles.failed}>{failed.join(', ')} didn’t answer.</Text> : null}
    </Section>
  )
}

/** The filters on, each a chip that takes it off */
function ActiveFilters({ value, sources, onChange }: { value: Refine; sources: Map<string, string>; onChange: (value: Refine) => void }) {
  const label = <T,>(list: { value: T; label: string }[], v: T) => list.find((o) => o.value === v)?.label ?? String(v)
  const chips: { key: string; label: string; off: Refine }[] = [
    ...(value.exact ? [{ key: 'exact', label: 'Every word', off: { ...value, exact: false } }] : []),
    ...value.qualities.map((v) => ({ key: `q${v}`, label: label(QUALITIES, v), off: { ...value, qualities: toggle(value.qualities, v) } })),
    ...value.what.map((v) => ({ key: `w${v}`, label: label(WHATS, v), off: { ...value, what: toggle(value.what, v) } })),
    ...value.sizes.map((v) => ({ key: `s${v}`, label: label(SIZES, v), off: { ...value, sizes: toggle(value.sizes, v) } })),
    ...value.codecs.map((v) => ({ key: `c${v}`, label: label(CODECS, v), off: { ...value, codecs: toggle(value.codecs, v) } })),
    ...value.sources.map((v) => ({ key: `f${v}`, label: sources.get(v) ?? v, off: { ...value, sources: toggle(value.sources, v) } })),
  ]
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.active}>
      {chips.map((c) => (
        <Press key={c.key} onPress={() => onChange(c.off)} scale={0.95} style={styles.token} accessibilityRole="button" accessibilityLabel={`Remove ${c.label}`}>
          <Text style={styles.tokenLabel}>{c.label}</Text>
          <Ionicons name="close" size={15} color={color.accent} />
        </Press>
      ))}
      {chips.length > 1 ? (
        <Press onPress={() => onChange({ ...NO_REFINE, sort: value.sort })} scale={0.95} style={styles.clear} accessibilityRole="button">
          <Text style={[text.small, { color: color.textSoft }]}>Clear all</Text>
        </Press>
      ) : null}
    </ScrollView>
  )
}

/** A plugin's video: its picture when it has one, its name, where it is from and what it is */
function VideoRow({ item, from, onPress }: { item: Found; from: string; onPress: () => void }) {
  const what = [item.kind === 'hls' ? 'Stream' : 'Video', item.year ? String(item.year) : '', item.quality ?? '', formatSize(item.size)].filter(Boolean).join(', ')
  return (
    <Press onPress={onPress} scale={0.98} style={[styles.video, !item.matches && { opacity: 0.6 }]} accessibilityLabel={`Play ${item.name}`}>
      <View style={styles.thumb}>
        {item.poster ? <Image source={{ uri: item.poster }} style={StyleSheet.absoluteFill} contentFit="cover" /> : <Ionicons name={item.kind === 'hls' ? 'radio-outline' : 'film-outline'} size={22} color={color.textMuted} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.videoName} numberOfLines={2}>
          {item.title !== item.name ? item.title : item.name}
        </Text>
        <Text style={styles.videoMeta} numberOfLines={1}>
          {what}
          {from ? ` from ${from}` : ''}
        </Text>
      </View>
      <Ionicons name="play" size={18} color={color.accent} />
    </Press>
  )
}

function ChannelSection({ groups, q, all }: { groups: Group<LiveChannel>[]; q: string; all: boolean }) {
  const play = usePlayAnything()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [tuning, setTuning] = useState<string | null>(null)
  if (!groups.length) return null
  const loading = groups.some((g) => g.loading)
  const items = groups.flatMap((g) => g.items.map((c) => ({ plugin: g.provider, from: g.name, channel: c })))
  const shown = all || open ? items : items.slice(0, FIRST)
  return (
    <Section title="Channels" count={items.length} loading={loading}>
      {shown.map(({ plugin, from, channel }) => (
        <Press
          key={plugin + channel.id}
          scale={0.98}
          style={styles.video}
          accessibilityLabel={`Watch ${channel.name}`}
          onPress={() => {
            setTuning(plugin + channel.id)
            play
              .channel(plugin, channel)
              .catch((e: Error) => toast(e.message, { tone: 'error' }))
              .finally(() => setTuning(null))
          }}
        >
          <View style={styles.channelNumber}>
            <Text style={styles.channelNumberText}>{channel.number}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.videoName} numberOfLines={1}>
              {channel.name}
            </Text>
            <Text style={styles.videoMeta} numberOfLines={1}>
              {[channel.group, from].filter(Boolean).join(', ')}
            </Text>
          </View>
          {tuning === plugin + channel.id ? <ActivityIndicator size="small" color={color.accent} /> : <Ionicons name="play" size={18} color={color.accent} />}
        </Press>
      ))}
      {!loading && !items.length ? <Empty>No channel called “{q}”.</Empty> : null}
      {!all && !open && items.length > FIRST ? <More label={`Show all ${items.length}`} onPress={() => setOpen(true)} /> : null}
    </Section>
  )
}

/** A plugin's chip chosen: its rows for the words, drawn as the plugin's rows are everywhere (its cards open its screens) */
function ChipResults({ chip, q }: { chip: SearchChip; q: string }) {
  const rows = chip.rows.filter((r) => !('items' in r) || (r.items?.length ?? 0) > 0)
  if (chip.loading) {
    return (
      <View style={styles.chipLoading}>
        <ActivityIndicator color={color.textMuted} />
      </View>
    )
  }
  if (!rows.length) return <View style={styles.section}><Empty>{q.length < 3 ? 'Type a few more letters.' : `Nothing in ${chip.label} for “${q}”.`}</Empty></View>
  return (
    <View style={styles.section}>
      {rows.map((row) => (
        <PluginRowView key={row.key} plugin={chip.plugin} row={row} />
      ))}
    </View>
  )
}

/** A pasted link: read when asked, then what it is and what it holds, each playable */
function LinkView({ text: typed, reading, error, answer, onRead }: { text: string; reading: boolean; error: string | null; answer: LinkInspection | null; onRead: () => void }) {
  const play = usePlayAnything()
  const host = hostOf(normalizeLink(typed))
  if (!answer) {
    return (
      <View style={styles.linkBox}>
        <Press onPress={onRead} disabled={reading} scale={0.98} style={styles.open} accessibilityRole="button">
          {reading ? <ActivityIndicator color={color.onAccent} /> : <Ionicons name="arrow-forward" size={20} color={color.onAccent} />}
          <Text style={styles.openLabel}>{reading ? `Reading ${host}…` : `Open ${host}`}</Text>
        </Press>
        <Text style={styles.hint}>The server reads the link: a video or a stream plays here, a page shows the videos, magnets and torrents it links to.</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    )
  }
  const playable = answer.items
  return (
    <ScrollView keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: space.xxxl + 64 }}>
      <View style={styles.linkHead}>
        <Text style={text.title} numberOfLines={2}>
          {answer.title || host}
        </Text>
        <Text style={styles.linkWhat}>{linkSummary(answer)}</Text>
      </View>
      {playable.map((item, i) => (
        <Press key={item.url + i} onPress={() => play.link(item)} scale={0.98} style={styles.video} accessibilityLabel={`Play ${item.label}`}>
          <View style={styles.thumb}>
            <Ionicons name={LINK_ICONS[item.kind]} size={22} color={color.accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.videoName} numberOfLines={2}>
              {item.label}
            </Text>
            <Text style={styles.videoMeta} numberOfLines={1}>
              {[LINK_KINDS[item.kind], formatSize(item.size)].filter(Boolean).join(', ')}
            </Text>
          </View>
          <Ionicons name="play" size={18} color={color.accent} />
        </Press>
      ))}
      {!playable.length ? <Empty>Nothing on this page plays: no video, stream, magnet or torrent link.</Empty> : null}
      {answer.truncated ? <Text style={styles.failed}>The page is longer than the server reads: links further down aren’t listed.</Text> : null}
    </ScrollView>
  )
}

const LINK_ICONS: Record<LinkItem['kind'], IconName> = { video: 'film-outline', hls: 'radio-outline', magnet: 'magnet-outline', torrent: 'document-attach-outline' }
const LINK_KINDS: Record<LinkItem['kind'], string> = { video: 'Video file', hls: 'Stream', magnet: 'Magnet', torrent: 'Torrent file' }

function linkSummary(a: LinkInspection): string {
  if (a.kind !== 'page') return `${LINK_KINDS[a.kind]}, ready to play`
  const count = (kind: LinkItem['kind'], one: string, many: string) => {
    const n = a.items.filter((i) => i.kind === kind).length
    return n ? `${n} ${n === 1 ? one : many}` : ''
  }
  const parts = [count('video', 'video', 'videos'), count('hls', 'stream', 'streams'), count('magnet', 'magnet', 'magnets'), count('torrent', 'torrent', 'torrents')].filter(Boolean)
  return parts.length ? `A page with ${parts.join(', ')}` : 'A page'
}

function hostOf(url: string): string {
  if (/^magnet:/i.test(url) || /^[a-f0-9]{40}$/i.test(url)) return 'the magnet'
  try {
    return new URL(url).host
  } catch {
    return 'the link'
  }
}

function More({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Press onPress={onPress} scale={0.98} style={styles.more} accessibilityRole="button">
      <Text style={styles.moreLabel}>{label}</Text>
      <Ionicons name="chevron-down" size={16} color={color.accent} />
    </Press>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <Text style={styles.empty}>{children}</Text>
}

const styles = StyleSheet.create({
  field: {
    marginHorizontal: space.l,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s,
    backgroundColor: color.surface2,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    paddingLeft: space.l,
    paddingRight: space.s,
    height: 50,
  },
  input: { flex: 1, color: color.text, fontFamily: font.medium, fontSize: 16, paddingVertical: 0 },
  hint: { ...text.small, marginTop: space.m, marginBottom: space.s },
  heading: { marginTop: space.l },
  scopes: { gap: space.s, paddingHorizontal: space.l, paddingTop: space.m, paddingBottom: space.xs },
  scope: { height: 36, justifyContent: 'center', paddingHorizontal: space.m + 2, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  scopeOn: { backgroundColor: color.text, borderColor: color.text },
  scopeLabel: { fontFamily: font.medium, fontSize: 14, color: color.textSoft },
  scopeLabelOn: { fontFamily: font.semibold, color: color.onFocus },
  section: { marginTop: space.xl },
  sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: space.l, marginBottom: space.m },
  count: { ...text.small, fontVariant: ['tabular-nums'] },
  row: { paddingHorizontal: space.l, gap: space.s },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s, rowGap: space.l, paddingHorizontal: space.l },
  item: { paddingHorizontal: space.l, marginBottom: space.s },
  video: { flexDirection: 'row', alignItems: 'center', gap: space.m, marginHorizontal: space.l, marginBottom: space.s, padding: space.s, paddingRight: space.l, borderRadius: radius.m, backgroundColor: color.surface2 },
  thumb: { width: 72, height: 48, borderRadius: radius.s, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface3 },
  videoName: { fontFamily: font.semibold, fontSize: 14, lineHeight: 19, color: color.text },
  videoMeta: { ...text.tiny, color: color.textMuted, marginTop: 2 },
  channelNumber: { width: 72, height: 48, borderRadius: radius.s, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface3 },
  channelNumberText: { fontFamily: font.display, fontSize: 18, color: color.text, fontVariant: ['tabular-nums'] },
  tools: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m, paddingHorizontal: space.l, marginBottom: space.m },
  toolsCount: { ...text.small, flex: 1 },
  tool: { flexDirection: 'row', alignItems: 'center', gap: space.xs, height: 38, paddingHorizontal: space.m, borderRadius: radius.pill, backgroundColor: color.surface1, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  toolOn: { borderColor: color.accentDeep },
  toolLabel: { fontFamily: font.semibold, fontSize: 14, color: color.text },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: color.accent },
  badgeLabel: { fontFamily: font.semibold, fontSize: 12, lineHeight: 14, color: color.onAccent, includeFontPadding: false },
  active: { gap: space.s, paddingHorizontal: space.l, paddingBottom: space.m },
  token: { flexDirection: 'row', alignItems: 'center', gap: space.xs, height: 34, paddingLeft: space.m, paddingRight: space.s, borderRadius: radius.pill, borderWidth: 1, borderColor: color.accentDeep, backgroundColor: color.surface1 },
  tokenLabel: { fontFamily: font.semibold, fontSize: 14, color: color.accent },
  clear: { height: 34, justifyContent: 'center', paddingHorizontal: space.s },
  chipLoading: { height: 160, alignItems: 'center', justifyContent: 'center' },
  more: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start', marginHorizontal: space.l, paddingVertical: space.s },
  moreLabel: { fontFamily: font.semibold, fontSize: 14, color: color.accent },
  empty: { ...text.small, paddingHorizontal: space.l },
  failed: { ...text.tiny, paddingHorizontal: space.l, marginTop: space.xs },
  linkBox: { paddingHorizontal: space.l, paddingTop: space.xl },
  open: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.s, height: 52, borderRadius: radius.pill, backgroundColor: color.accent },
  openLabel: { fontFamily: font.semibold, fontSize: 16, color: color.onAccent },
  error: { ...text.small, color: color.error, marginTop: space.m },
  linkHead: { paddingHorizontal: space.l, paddingTop: space.xl, paddingBottom: space.l },
  linkWhat: { ...text.small, marginTop: space.xs },
})
