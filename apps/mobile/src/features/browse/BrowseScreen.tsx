import { useState } from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated'
import { LIST_NAMES, SORTS, cleared, effectiveSort, emptyQuery, filterCount, isListName, showsList, tokens, type BrowseQuery } from '../../core/catalog/browse'
import { titlesOf } from '../../core/services/catalog'
import { useClient } from '../../state/app'
import { useBackPress } from '../../state/hooks'
import { queries } from '../../state/queries'
import { Loading, Message, TitleCard } from '../../ui/components'
import { SkeletonRow } from '../../ui/loading'
import { color, space } from '../../ui/theme'
import { BAR, BrowseHeader } from './BrowseHeader'
import { FilterSheet } from './FilterSheet'

// See all: a catalogue to wander through when you don't know what to watch.
// Its header (BrowseHeader) names what it shows ("Coming soon", "Best rated
// movies"), how many, and the filters on as chips that remove them; it folds
// into a one-line bar as the grid scrolls. Filters (FilterSheet) changes
// everything at once and says how many titles it will show before you apply.

type Params = { mediaType: string; list?: string; genre?: string; label?: string }

const COLUMNS = 3

export default function BrowseScreen() {
  const params = useLocalSearchParams<Params>()
  const mediaType = params.mediaType === 'tv' ? 'tv' : 'movie'
  const client = useClient()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const [query, setQuery] = useState<BrowseQuery>(() => {
    const start = emptyQuery(isListName(params.list) ? params.list : null)
    return params.genre ? { ...start, sort: start.sort === 'list' ? 'popularity' : start.sort, genres: [Number(params.genre)] } : start
  })
  const [sheet, setSheet] = useState(false)
  // The header's body, measured: the grid starts under it; a first guess until then
  const [body, setBody] = useState(150)
  useBackPress(sheet, () => setSheet(false))

  const genres = useQuery(queries.genres(client, mediaType))
  const browse = useInfiniteQuery(queries.browse(client, mediaType, query))
  const titles = browse.data?.pages.flatMap((p) => titlesOf(p)) ?? []
  const total = browse.data?.pages[0]?.totalResults
  const tile = (width - space.l * 2 - space.s * (COLUMNS - 1)) / COLUMNS
  const genreName = (id: number) => genres.data?.find((g) => g.id === id)?.name
  const noun = mediaType === 'movie' ? 'movies' : 'shows'
  // What the page shows: the list it came from, else the order ("Best rated movies"); the filters are its chips
  const heading = showsList(query) ? params.label || LIST_NAMES[query.list] : `${SORTS.find((s) => s.value === effectiveSort(query))!.word} ${noun}`
  const count = total == null ? ' ' : total === 0 ? `No ${noun}` : `${total.toLocaleString()} ${total === 1 ? noun.slice(0, -1) : noun}`

  const scrollY = useSharedValue(0)
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y
  })

  return (
    <View style={styles.page}>
      <Animated.FlatList
        key={COLUMNS}
        data={titles}
        numColumns={COLUMNS}
        keyExtractor={(t) => t.mediaType + t.tmdbId}
        columnWrapperStyle={styles.columns}
        contentContainerStyle={{ paddingTop: insets.top + BAR + body + space.xs, paddingBottom: insets.bottom + space.xxxl, gap: space.l }}
        scrollIndicatorInsets={{ top: insets.top + BAR }}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onEndReachedThreshold={0.8}
        onEndReached={() => browse.hasNextPage && !browse.isFetchingNextPage && browse.fetchNextPage()}
        initialNumToRender={12}
        windowSize={7}
        // Windowed only (see ROW_LIST): detached posters can come back blank
        removeClippedSubviews={false}
        ListEmptyComponent={
          browse.isPending ? (
            <View style={{ gap: space.l }}>
              {[0, 1, 2].map((i) => (
                <SkeletonRow key={i} width={tile} ratio={1.5} count={COLUMNS} index={i} />
              ))}
            </View>
          ) : browse.isError ? (
            <Message title="This list didn’t load" body={browse.error.message} action={{ label: 'Try again', onPress: () => browse.refetch() }} />
          ) : (
            <Message title={`No ${noun} like that`} body="Remove a filter, or choose another decade or score." action={{ label: 'Clear filters', onPress: () => setQuery(cleared(query)) }} />
          )
        }
        ListFooterComponent={
          browse.isFetchingNextPage ? (
            <View style={{ height: 140 }}>
              <Loading />
            </View>
          ) : undefined
        }
        renderItem={({ item }) => <TitleCard title={item} width={tile} scope="browse" />}
      />

      <BrowseHeader
        title={heading}
        count={count}
        tokens={tokens(query, genreName)}
        filters={filterCount(query)}
        scrollY={scrollY}
        body={body}
        onBody={setBody}
        onFilters={() => setSheet(true)}
        onRemove={(t) => setQuery(t.without)}
        onClear={() => setQuery(cleared(query))}
      />

      {sheet ? (
        <FilterSheet
          mediaType={mediaType}
          query={query}
          genres={genres.data ?? []}
          focus={null}
          onClose={() => setSheet(false)}
          onApply={(next) => {
            setQuery(next)
            setSheet(false)
          }}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg },
  columns: { gap: space.s, paddingHorizontal: space.l },
})
