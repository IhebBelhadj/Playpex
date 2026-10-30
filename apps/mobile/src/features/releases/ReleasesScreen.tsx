import { useState } from 'react'
import { FlatList, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import Ionicons from '@expo/vector-icons/Ionicons'
import type { PlayTitle } from '../../core/services/playback'
import type { Finder, Quality, ReleaseKind } from '../../core/services/releases'
import { useClient } from '../../state/app'
import { useDebouncedValue } from '../../state/hooks'
import { usePlayFound } from '../../state/playback'
import { queries } from '../../state/queries'
import { IconButton, Loading, Message } from '../../ui/components'
import { SkeletonRow } from '../../ui/loading'
import { Chip } from '../../ui/section'
import { color, font, radius, space, text } from '../../ui/theme'
import { ROW_HEIGHT, ReleaseRow } from './ReleaseRow'

// Find releases: the deep search, for when the Play list doesn't have it (or
// to choose for yourself). Every torrent provider and every stream provider of
// the server, one at a time, with keywords and a quality; torrents most seeded
// first, more as you scroll. A tap plays it; opened from a title, it plays as
// that title (progress, subtitles); from Search, with nothing saved.

type Params = { kind?: string; q?: string; title?: string }

const QUALITIES: { value: Quality | null; label: string }[] = [
  { value: null, label: 'Any quality' },
  { value: '2160p', label: '4K' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: 'SD', label: 'SD' },
]

export default function ReleasesScreen() {
  const params = useLocalSearchParams<Params>()
  const [title] = useState(() => (params.title ? (JSON.parse(params.title) as PlayTitle) : null))
  const [kind, setKind] = useState<ReleaseKind>(title?.mediaType ?? (params.kind === 'tv' ? 'tv' : 'movie'))
  const [q, setQ] = useState(params.q ?? (title ? title.title : ''))
  const keywords = useDebouncedValue(q.trim(), 450)
  const [quality, setQuality] = useState<Quality | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const client = useClient()
  const insets = useSafeAreaInsets()
  const finders = useQuery(queries.finders(client, kind))
  const list = finders.data ?? []
  const finder = list.find((f) => f.id === chosen) ?? list.find((f) => f.default) ?? list[0] ?? null

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        <IconButton icon="chevron-back" label="Back" glass onPress={() => router.back()} />
        <View style={{ flex: 1 }}>
          <Text style={text.title}>Find releases</Text>
          {title ? (
            <Text style={text.small} numberOfLines={1}>
              Plays as {title.title}
              {title.season != null ? `, season ${title.season} episode ${title.episode}` : ''}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.field}>
        <Ionicons name="search" size={18} color={color.textMuted} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder={kind === 'tv' ? 'A show, a season, an episode' : 'A movie, a year'}
          placeholderTextColor={color.textDim}
          returnKeyType="search"
          autoCorrect={false}
          cursorColor={color.accent}
          selectionColor={color.accent}
          style={styles.input}
        />
        {q ? <IconButton icon="close-circle" size={18} label="Clear" onPress={() => setQ('')} /> : null}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.chipsRow}>
        {!title ? (
          <>
            <Chip label="Movies" on={kind === 'movie'} onPress={() => setKind('movie')} />
            <Chip label="Shows" on={kind === 'tv'} onPress={() => setKind('tv')} />
            <View style={styles.divider} />
          </>
        ) : null}
        {list.map((f) => (
          <Chip key={f.id} label={f.kind === 'streams' ? `${f.name} (streams)` : f.name} on={f.id === finder?.id} onPress={() => setChosen(f.id)} />
        ))}
      </ScrollView>
      {finder?.kind === 'torrents' ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.chipsRow}>
          {QUALITIES.map((o) => (
            <Chip key={o.label} label={o.label} on={quality === o.value} onPress={() => setQuality(o.value)} />
          ))}
        </ScrollView>
      ) : null}
      {finders.isPending ? (
        <Loading />
      ) : !finder ? (
        <Message
          icon="search-outline"
          title="Nothing to search with yet"
          body="Releases come from the server’s plugins: its admin installs torrent and stream providers on the dashboard."
        />
      ) : (
        <Results finder={finder} kind={kind} q={keywords} quality={finder.kind === 'torrents' ? quality : null} imdb={title?.imdbId ?? null} title={title} bottom={insets.bottom} />
      )}
    </View>
  )
}

function Results({
  finder,
  kind,
  q,
  quality,
  imdb,
  title,
  bottom,
}: {
  finder: Finder
  kind: ReleaseKind
  q: string
  quality: Quality | null
  imdb: string | null
  title: PlayTitle | null
  bottom: number
}) {
  const client = useClient()
  const play = usePlayFound()
  const { width } = useWindowDimensions()
  const found = useInfiniteQuery(queries.found(client, finder, { kind, q, quality, imdb }))
  const items = found.data?.pages.flatMap((p) => p.items) ?? []
  const top = Math.max(1, ...items.map((i) => i.seeds ?? 0))

  if (finder.kind === 'streams' && !q) return <Message icon="search-outline" title={`Search ${finder.name}`} body="Type what you’re looking for: this provider searches by keywords." />
  if (found.isPending) {
    return (
      <View style={styles.skeletons}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <SkeletonRow key={i} width={width - space.l * 2} ratio={ROW_HEIGHT / (width - space.l * 2)} count={1} index={i} />
        ))}
      </View>
    )
  }
  if (found.isError) return <Message title={`${finder.name} didn’t answer`} body={found.error.message} action={{ label: 'Try again', onPress: () => found.refetch() }} />
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.key}
      contentContainerStyle={{ paddingHorizontal: space.l, paddingTop: space.l, paddingBottom: bottom + space.xxl, gap: space.s }}
      onEndReachedThreshold={0.6}
      onEndReached={() => found.hasNextPage && !found.isFetchingNextPage && found.fetchNextPage()}
      ListEmptyComponent={<Message title="No releases found" body={q ? `${finder.name} has nothing for “${q}”. Try fewer words, or another provider.` : `${finder.name} lists nothing here yet.`} />}
      ListFooterComponent={found.isFetchingNextPage ? <View style={{ height: 120 }}><Loading /></View> : undefined}
      renderItem={({ item }) => <ReleaseRow item={item} top={top} onPress={() => play(item, title)} />}
    />
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg },
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.l, paddingTop: space.s, paddingBottom: space.m },
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
    height: 48,
  },
  input: { flex: 1, color: color.text, fontFamily: font.medium, fontSize: 16, paddingVertical: 0, includeFontPadding: false },
  chipsRow: { flexGrow: 0, flexShrink: 0, marginTop: space.m },
  chips: { paddingHorizontal: space.l, gap: space.s, alignItems: 'center' },
  divider: { width: StyleSheet.hairlineWidth, height: 22, backgroundColor: color.lineStrong, marginHorizontal: space.xs },
  skeletons: { paddingTop: space.l, gap: space.s },
})
