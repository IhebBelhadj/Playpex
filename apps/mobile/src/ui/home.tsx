import { useState } from 'react'
import { FlatList, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { Image } from 'expo-image'
import { LinearGradient } from 'expo-linear-gradient'
import Ionicons from '@expo/vector-icons/Ionicons'
import Animated, { FadeIn } from 'react-native-reanimated'
import type { Schemas } from '../lib/api'
import { image, useImageBase, type Title } from '../lib/catalog'
import { openPlay } from '../lib/playback'
import { Button, CAPTION_HEIGHT, MorphImage, ProgressBar, ROW_LIST, RowHeading, RowSkeleton, TitleCaption, openTitle, posterTag } from './components'
import { Press } from './press'
import { useMorphTag } from '../state/boundary'
import { color, fade, font, motion, radius, space, text } from './theme'

// Home's own pieces: the hero (picks for this profile, swiped through), the
// landscape cards of what it is watching, and the Top 10 with its numerals.

export type Pick = { title: Title; why: string }



export function Hero({ picks, genres }: { picks: Pick[]; genres: Map<number, string> | undefined }) {
  const { width, height } = useWindowDimensions()
  const heroHeight = Math.round(Math.min(Math.max(height * 0.7, 480), 660))
  const [page, setPage] = useState(0)
  if (!picks.length) return <View style={{ height: heroHeight, backgroundColor: color.surface2 }} />
  return (
    <View style={{ height: heroHeight }}>
      <FlatList
        {...ROW_LIST}
        horizontal
        pagingEnabled
        data={picks}
        keyExtractor={(p) => p.title.mediaType + p.title.tmdbId}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        renderItem={({ item }) => <HeroPage pick={item} width={width} height={heroHeight} genres={genres} />}
      />
      {picks.length > 1 ? (
        <View style={styles.dots} pointerEvents="none">
          {picks.map((p, i) => (
            <View key={p.title.tmdbId} style={[styles.dot, i === page && styles.dotOn]} />
          ))}
        </View>
      ) : null}
    </View>
  )
}

function HeroPage({ pick, width, height, genres }: { pick: Pick; width: number; height: number; genres: Map<number, string> | undefined }) {
  const base = useImageBase()
  const { title: t } = pick
  const tag = posterTag('hero', t.mediaType, t.tmdbId)
  const morph = useMorphTag(tag)
  const genre = t.genreIds.map((g) => genres?.get(g)).filter(Boolean).slice(0, 2)
  const open = () => morph.open(() => openTitle(t.mediaType, t.tmdbId, { tag, posterPath: t.posterPath, backdropPath: t.backdropPath, title: t.title }))
  // The list at once, with what the pick knows: it completes the title (its IMDb id) itself
  const play = () => openPlay({ mediaType: t.mediaType, tmdbId: t.tmdbId, imdbId: null, title: t.title, year: t.year ? Number(t.year) : null, posterPath: t.posterPath, backdropPath: t.backdropPath })

  return (
    <View style={{ width, height }}>
      {/* The picture opens the title; the buttons sit beside it, never inside another pressable */}
      <Press onPress={open} scale={1} style={StyleSheet.absoluteFill} accessibilityLabel={t.title} accessibilityRole="button">
        <MorphImage key={morph.key} uri={image(base, t.backdropPath, 'w780')} tag={morph.tag} fade={motion.slow} />
        <LinearGradient colors={fade.top} style={[StyleSheet.absoluteFill, { bottom: '70%' }]} />
        <LinearGradient colors={fade.melt} style={StyleSheet.absoluteFill} />
      </Press>
      <Animated.View entering={FadeIn.duration(motion.slow)} style={styles.heroBody} pointerEvents="box-none">
        <Text style={styles.why} numberOfLines={1}>
          {pick.why}
        </Text>
        <Text style={text.marquee} numberOfLines={3} adjustsFontSizeToFit minimumFontScale={0.7}>
          {t.title}
        </Text>
        <View style={styles.meta}>
          {t.year ? <Text style={styles.metaText}>{t.year}</Text> : null}
          {t.voteAverage ? (
            <View style={styles.score}>
              <Ionicons name="star" size={12} color={color.accent} />
              <Text style={styles.metaText}>{t.voteAverage.toFixed(1)}</Text>
            </View>
          ) : null}
          {genre.map((g) => (
            <Text key={g} style={styles.metaText}>
              {g}
            </Text>
          ))}
        </View>
        <View style={styles.heroActions}>
          <Button icon="play" label="Play" onPress={play} style={{ flex: 1 }} />
          <Button kind="secondary" icon="information-circle-outline" label="Details" onPress={open} style={{ flex: 1 }} />
        </View>
      </Animated.View>
    </View>
  )
}

type Continue = Schemas['ContinueWatchingItem']

export const CARD_WIDTH = 248

/** What this profile is watching, as stills with how far it got */
export function ContinueRow({ items }: { items: Continue[] }) {
  const base = useImageBase()
  if (!items.length) return null

  // A movie: the sheet at once, the title as the card knows it (the sheet completes it from the catalog)
  function resume(item: Continue) {
    if (item.kind === 'next' || item.mediaType === 'tv') return openTitle(item.mediaType, item.tmdbId)
    const title = { mediaType: item.mediaType, tmdbId: item.tmdbId, imdbId: null, title: item.title ?? '', year: null, posterPath: item.posterPath ?? null, backdropPath: item.backdropPath ?? null }
    openPlay(title, { positionS: item.positionS ?? 0, durationS: item.durationS, fileId: item.fileId, infoHash: item.infoHash, filePath: item.filePath })
  }

  return (
    <View style={{ marginBottom: space.xxl }}>
      <RowHeading title="Continue watching" />
      <FlatList
        {...ROW_LIST}
        horizontal
        data={items}
        keyExtractor={(c) => `${c.mediaType}${c.tmdbId}-${c.season}-${c.episode}`}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: space.l, gap: space.m }}
        renderItem={({ item }) => {
          const left = item.durationS && item.positionS != null ? Math.max(1, Math.round((item.durationS - item.positionS) / 60)) : null
          const line =
            item.mediaType === 'tv'
              ? `${item.kind === 'next' ? 'Next: ' : ''}Season ${item.season}, episode ${item.episode}`
              : left != null
                ? `${left} min left`
                : ''
          return (
            <Press onPress={() => resume(item)} style={{ width: CARD_WIDTH }} accessibilityLabel={item.title ?? ''}>
              <View style={styles.still}>
                {item.backdropPath ? <Image source={image(base, item.backdropPath, 'w780')} style={StyleSheet.absoluteFill} contentFit="cover" transition={motion.base} /> : null}
                <LinearGradient colors={fade.toBg} locations={[0.4, 0.8, 1]} style={StyleSheet.absoluteFill} />
                <View style={styles.playDisc}>
                  <Ionicons name="play" size={18} color={color.onAccent} style={{ marginLeft: 2 }} />
                </View>
                {item.kind === 'resume' ? <ProgressBar ratio={item.ratio ?? 0} style={styles.stillProgress} /> : null}
              </View>
              <Text style={[text.label, { marginTop: space.s }]} numberOfLines={1}>
                {item.title}
              </Text>
              {line ? (
                <Text style={text.small} numberOfLines={1}>
                  {line}
                </Text>
              ) : null}
            </Press>
          )
        }}
      />
    </View>
  )
}

const TOP_POSTER = 112

/** The week's ten most watched, ranked: the numeral stands behind its poster */
export function TopTenRow({ label, titles, loading, scope }: { label: string; titles: Title[] | undefined; loading?: boolean; scope: string }) {
  if (!loading && !titles?.length) return null
  return (
    <View style={{ marginBottom: space.xxl }}>
      <RowHeading title={label} />
      {loading ? (
        <RowSkeleton width={TOP_POSTER} />
      ) : (
        <FlatList
          {...ROW_LIST}
          horizontal
          data={titles!.slice(0, 10)}
          keyExtractor={(t) => t.mediaType + t.tmdbId}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: space.l, gap: space.xs }}
          renderItem={({ item, index }) => <RankPoster title={item} index={index} scope={scope} />}
        />
      )}
    </View>
  )
}

function RankPoster({ title: item, index, scope }: { title: Title; index: number; scope: string }) {
  const base = useImageBase()
  const tag = posterTag(scope, item.mediaType, item.tmdbId)
  const morph = useMorphTag(tag)
  return (
    <Press
      onPress={() => morph.open(() => openTitle(item.mediaType, item.tmdbId, { tag, posterPath: item.posterPath, backdropPath: item.backdropPath, title: item.title }))}
      style={styles.rank}
      accessibilityLabel={`Number ${index + 1}, ${item.title}`}
    >
      <Text style={[styles.numeral, index === 9 && { letterSpacing: -14 }]} allowFontScaling={false}>
        {index + 1}
      </Text>
      <View style={{ width: TOP_POSTER }}>
        <View style={styles.rankPoster}>
          <MorphImage key={morph.key} uri={image(base, item.posterPath, 'w342')} tag={morph.tag} fade={motion.base} round={radius.m} />
        </View>
        <TitleCaption title={item} />
      </View>
    </Press>
  )
}

const styles = StyleSheet.create({
  heroBody: { position: 'absolute', left: space.l, right: space.l, bottom: space.xxl + space.s },
  why: { ...text.small, color: color.accent, marginBottom: space.s },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.m, rowGap: space.xs, marginTop: space.s },
  metaText: { ...text.small, color: color.textSecondary },
  score: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  heroActions: { flexDirection: 'row', gap: space.m, marginTop: space.l },
  dots: { position: 'absolute', bottom: space.m, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.lineStrong },
  dotOn: { width: 18, backgroundColor: color.accent },
  still: { width: CARD_WIDTH, height: CARD_WIDTH * 0.5625, borderRadius: radius.m, overflow: 'hidden', backgroundColor: color.surface2 },
  stillProgress: { position: 'absolute', left: space.m, right: space.m, bottom: space.m },
  playDisc: {
    position: 'absolute',
    left: space.m,
    bottom: space.m + 10,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rank: { flexDirection: 'row', alignItems: 'flex-end', paddingRight: space.s },
  numeral: { fontFamily: font.display, fontSize: 136, lineHeight: 136, color: color.accentGhost, marginRight: -26, marginBottom: CAPTION_HEIGHT - 18, letterSpacing: -6 },
  rankPoster: { width: TOP_POSTER, height: TOP_POSTER * 1.5, borderRadius: radius.m, overflow: 'hidden', backgroundColor: color.surface2 },
})
