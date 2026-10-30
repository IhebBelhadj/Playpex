import { useMemo, useState } from 'react'
import { FlatList, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { Image } from 'expo-image'
import { LinearGradient } from 'expo-linear-gradient'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Ionicons from '@expo/vector-icons/Ionicons'
import Animated, { FadeIn, FadeInDown, interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated'
import { unwrap, type Schemas } from '../../../lib/api'
import { image, useCredits, useDetails, useImageBase, useImdbRating, useSeason, type Details, type MediaType } from '../../../lib/catalog'
import { formatTime, openPlay, playTitle } from '../../../lib/playback'
import { useCanFindReleases, useSlotRows } from '../../../lib/plugins'
import { useHistory, unseen, useSimilar } from '../../../lib/recommend'
import { useApi, useProfile } from '../../../lib/session'
import { useLeave } from '../../../state/hooks'
import { useArrivingTag } from '../../../state/boundary'
import { openReleases } from '../../../state/navigation'
import { Action, Button, IconButton, Message, MorphImage, ProgressBar, ROW_LIST, Row } from '../../../ui/components'
import { PluginRowView } from '../../../ui/plugin-rows'
import { Press } from '../../../ui/press'
import { Chip } from '../../../ui/section'
import { color, fade, font, motion, radius, space, text } from '../../../ui/theme'

// A title's page (docs/api/catalog.md, docs/api/profiles.md). The poster tapped
// to get here grows into this page's poster (a shared transition: the same tag);
// the backdrop, blurred, lights the whole page behind it. Then Play (or Resume),
// the list, ratings (IMDb, metadata plugins), a show's seasons and episodes,
// the cast, what plugins add (core.movie.rows / core.show.rows), similar titles.

type Params = { mediaType: MediaType; id: string; tag?: string; poster?: string; backdrop?: string; name?: string }

const POSTER_W = 118
/** The top bar under the status bar */
const BAR = 56

export default function TitleScreen() {
  const params = useLocalSearchParams<Params>()
  const mediaType = params.mediaType === 'tv' ? 'tv' : 'movie'
  const tmdbId = Number(params.id)
  const details = useDetails(mediaType, tmdbId)
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const base = useImageBase()

  // Drawn at once from what the tapped poster knew, then from the title's page
  // The tapped poster's own pictures first: the morph lands on exactly what it left
  const posterPath = params.poster || details.data?.posterPath || null
  const backdropPath = params.backdrop || details.data?.backdropPath || null
  const name = details.data?.title ?? params.name ?? ''
  // The morph runs in only: the tag is gone once it has landed, so leaving is a fade (useLeave)
  const { leaving, leave } = useLeave()
  const arriving = useArrivingTag(params.tag || undefined)
  const tag = (!leaving && arriving) || undefined
  const fromHero = params.tag?.startsWith('poster-hero') ?? false
  const backdropHeight = Math.round(width * 0.78)

  const scrollY = useSharedValue(0)
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y
  })
  const parallax = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(scrollY.value, [-200, 0, backdropHeight], [-60, 0, backdropHeight * 0.45], 'clamp') }, { scale: interpolate(scrollY.value, [-200, 0], [1.25, 1], 'clamp') }],
  }))
  // The headline folds into the bar as it reaches it: the poster and the title shrink and go
  // from the page while a small poster, the title and its year settle into the bar
  const barHeight = insets.top + BAR
  const reach = backdropHeight - POSTER_W * 0.95 - barHeight
  const fold = { from: reach - 40, to: reach + POSTER_W * 0.9 }
  const bar = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [fold.from, fold.to - 60], [0, 1], 'clamp') }))
  const bigPoster = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [fold.from + 40, fold.to - 30], [1, 0], 'clamp'),
    transform: [{ scale: interpolate(scrollY.value, [fold.from, fold.to], [1, 0.55], 'clamp') }],
  }))
  const bigTitle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [fold.from, fold.to - 70], [1, 0], 'clamp'),
    transform: [{ scale: interpolate(scrollY.value, [fold.from, fold.to], [1, 0.8], 'clamp') }],
  }))
  const smallPoster = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [fold.to - 70, fold.to], [0, 1], 'clamp'),
    transform: [{ translateY: interpolate(scrollY.value, [fold.to - 70, fold.to], [14, 0], 'clamp') }, { scale: interpolate(scrollY.value, [fold.to - 70, fold.to], [1.6, 1], 'clamp') }],
  }))
  const smallText = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [fold.to - 55, fold.to], [0, 1], 'clamp'),
    transform: [{ translateY: interpolate(scrollY.value, [fold.to - 55, fold.to], [10, 0], 'clamp') }],
  }))
  // The film's blurred light starts where its picture has melted into the page, never above it
  const glowFrom = Math.min(0.9, backdropHeight / height)

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      {/* The room lit by the film: its picture, blurred and dimmed, under the page from where the backdrop ends */}
      {backdropPath ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Image source={image(base, backdropPath, 'w92')} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={8} />
          <LinearGradient colors={glowStops(glowFrom)} style={StyleSheet.absoluteFill} />
        </View>
      ) : null}

      <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} contentContainerStyle={{ paddingBottom: space.xxxl + insets.bottom }}>
        {/* The picture drifts slower than the page inside its frame; the gradients stay on the frame, so it always melts at the same line */}
        <View style={{ width, height: backdropHeight, overflow: 'hidden' }}>
          <Animated.View style={[StyleSheet.absoluteFill, parallax]}>
            <MorphImage uri={image(base, backdropPath, 'w780')} tag={fromHero ? tag : undefined} fade={fromHero ? 0 : motion.base} />
          </Animated.View>
          <LinearGradient colors={fade.top} style={[StyleSheet.absoluteFill, { bottom: '65%' }]} pointerEvents="none" />
          <LinearGradient colors={fade.melt} style={StyleSheet.absoluteFill} pointerEvents="none" />
        </View>

        <View style={styles.headline}>
          <Animated.View style={[styles.poster, bigPoster]}>
            <MorphImage uri={image(base, posterPath, 'w342')} tag={fromHero ? undefined : tag} round={radius.m} />
          </Animated.View>
          <Animated.View style={[styles.headlineText, bigTitle]}>
            <Text style={name.length > 28 ? text.title : text.hero} numberOfLines={4}>
              {name}
            </Text>
            {details.data ? <Meta details={details.data} /> : null}
          </Animated.View>
        </View>

        {details.isError ? (
          <View style={{ height: 240 }}>
            <Message title="This title didn’t load" body={details.error.message} action={{ label: 'Try again', onPress: () => details.refetch() }} />
          </View>
        ) : details.data ? (
          <Animated.View entering={FadeInDown.duration(motion.slow)}>
            <Scores details={details.data} />
            <Actions details={details.data} />
            <Overview details={details.data} />
            {mediaType === 'tv' ? <Seasons details={details.data} /> : null}
            <Cast mediaType={mediaType} tmdbId={tmdbId} />
            <PluginRows details={details.data} />
            <MoreLikeThis mediaType={mediaType} tmdbId={tmdbId} />
          </Animated.View>
        ) : null}
      </Animated.ScrollView>

      <Animated.View style={[styles.bar, { height: barHeight }, bar]} pointerEvents="none" />
      <View style={[styles.barBody, { top: insets.top, height: BAR }]} pointerEvents="none">
        <Animated.View style={[styles.smallPoster, smallPoster]}>
          {posterPath ? <Image source={image(base, posterPath, 'w92')} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
        </Animated.View>
        <Animated.View style={[{ flex: 1 }, smallText]}>
          <Text style={styles.barTitle} numberOfLines={1}>
            {name}
          </Text>
          {details.data ? (
            <Text style={styles.barMeta} numberOfLines={1}>
              {metaPieces(details.data).join('   ')}
            </Text>
          ) : null}
        </Animated.View>
      </View>
      <View style={[styles.back, { top: insets.top + space.s }]}>
        <IconButton icon="chevron-back" label="Back" glass onPress={leave} />
      </View>
    </View>
  )
}

/**
 * The page's darkness over the film's blurred light, in even stops: solid until just past `from` (where
 * the backdrop has melted), the light rising slowly under the page, then solid again at the foot
 */
function glowStops(from: number): [string, string, ...string[]] {
  const n = 24
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    // Solid a little past the melt (no seam), rising gently to its peak, then fading at the foot
    const start = from + 0.04
    const peak = from + 0.3
    const lift = t < start ? 0 : t < peak ? (t - start) / (peak - start) : 1 - (t - peak) / (1 - peak)
    const eased = Math.max(0, Math.min(1, lift)) ** 2 * (3 - 2 * Math.max(0, Math.min(1, lift)))
    return `rgba(16, 13, 11, ${(1 - 0.28 * eased).toFixed(2)})`
  }) as [string, string, ...string[]]
}

function runtime(minutes: number | null) {
  if (!minutes) return null
  const h = Math.floor(minutes / 60)
  return h ? `${h} h ${minutes % 60 ? `${minutes % 60} min` : ''}`.trim() : `${minutes} min`
}

/** Its year, length, seasons: what the headline says under the title, and the bar once folded */
function metaPieces(details: Details): string[] {
  return [
    details.year,
    runtime(details.runtime),
    details.mediaType === 'tv' && details.seasonCount ? `${details.seasonCount} season${details.seasonCount > 1 ? 's' : ''}` : null,
  ].filter(Boolean) as string[]
}

function Meta({ details }: { details: Details }) {
  const pieces = metaPieces(details)
  return (
    <Animated.View entering={FadeIn.duration(motion.base)}>
      <View style={styles.meta}>
        {pieces.map((p) => (
          <Text key={p} style={styles.metaText}>
            {p}
          </Text>
        ))}
      </View>
      {details.genres.length ? (
        <Text style={[text.small, { marginTop: space.xs }]} numberOfLines={2}>
          {details.genres
            .slice(0, 3)
            .map((g) => g.name)
            .join(', ')}
        </Text>
      ) : null}
    </Animated.View>
  )
}

/** IMDb's rating, TMDB's score, and what metadata plugins add (Trakt…) */
function Scores({ details }: { details: Details }) {
  const api = useApi()
  const profile = useProfile()
  const imdb = useImdbRating(details.imdbId)
  const extras = useQuery({
    queryKey: ['catalog', 'extras', details.mediaType, details.tmdbId, profile.id],
    queryFn: () =>
      unwrap(
        api.GET('/catalog/titles/{mediaType}/{tmdbId}/extras', {
          params: { path: { mediaType: details.mediaType, tmdbId: details.tmdbId }, query: { profile: profile.id } },
        }),
      ),
    staleTime: 30 * 60 * 1000,
    retry: false,
  })
  const scores: { source: string; value: string }[] = []
  const imdbRating = imdb.data?.rating ?? null
  // TMDB's score only when IMDb has none: one rating people know, not two that disagree
  if (!imdbRating && details.voteAverage) scores.push({ source: 'TMDB', value: details.voteAverage.toFixed(1) })
  for (const provider of extras.data?.providers ?? []) {
    for (const r of provider.ratings) scores.push({ source: r.source, value: r.max === 10 ? r.value.toFixed(1) : `${Math.round(r.value)}/${r.max}` })
  }
  const tags = (extras.data?.providers ?? []).flatMap((p) => p.tags).slice(0, 6)
  if (!imdbRating && !scores.length && !tags.length) return null
  return (
    <View style={styles.scores}>
      {imdbRating ? (
        <View style={styles.score} accessibilityLabel={`IMDb rating ${imdbRating.toFixed(1)} out of 10`}>
          <ImdbMark />
          <Text style={styles.scoreValue}>{imdbRating.toFixed(1)}</Text>
          {imdb.data?.votes ? <Text style={text.tiny}>{formatVotes(imdb.data.votes)}</Text> : null}
        </View>
      ) : null}
      {scores.map((s) => (
        <View key={s.source} style={styles.score}>
          <Text style={styles.scoreValue}>{s.value}</Text>
          <Text style={text.tiny}>{s.source}</Text>
        </View>
      ))}
      {tags.map((t) => (
        <Text key={t} style={styles.tag}>
          {t}
        </Text>
      ))}
    </View>
  )
}

/** IMDb's mark as people know it: the black word on its yellow */
function ImdbMark() {
  return (
    <View style={styles.imdb}>
      <Text style={styles.imdbText}>IMDb</Text>
    </View>
  )
}

function formatVotes(votes: number): string {
  return votes >= 1e6 ? `${(votes / 1e6).toFixed(1)}M` : votes >= 1e3 ? `${Math.round(votes / 1e3)}K` : String(votes)
}

function Actions({ details }: { details: Details }) {
  const api = useApi()
  const profile = useProfile()
  const queryClient = useQueryClient()
  const path = { profileId: profile.id, mediaType: details.mediaType, tmdbId: details.tmdbId }

  const progress = useQuery({
    queryKey: ['progress', profile.id, details.mediaType, details.tmdbId],
    queryFn: () => unwrap(api.GET('/profiles/{profileId}/progress/{mediaType}/{tmdbId}', { params: { path } })),
  })
  const watchlist = useQuery({
    queryKey: ['watchlist', profile.id, details.mediaType, details.tmdbId],
    queryFn: () => unwrap(api.GET('/profiles/{profileId}/watchlist/{mediaType}/{tmdbId}', { params: { path } })),
  })
  const toggle = useMutation({
    mutationFn: async (add: boolean) => {
      if (add)
        await unwrap(
          api.PUT('/profiles/{profileId}/watchlist/{mediaType}/{tmdbId}', {
            params: { path },
            body: { title: details.title, posterPath: details.posterPath, backdropPath: details.backdropPath, genreIds: details.genreIds },
          }),
        )
      else await unwrap(api.DELETE('/profiles/{profileId}/watchlist/{mediaType}/{tmdbId}', { params: { path } }))
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['watchlist', profile.id, details.mediaType, details.tmdbId] })
      queryClient.invalidateQueries({ queryKey: ['library', profile.id] })
    },
  })

  const library = useQuery({
    queryKey: ['library', profile.id],
    queryFn: () => unwrap(api.GET('/profiles/{profileId}/library', { params: { path: { profileId: profile.id } } })),
    enabled: details.mediaType === 'tv',
  })
  const resume = details.mediaType === 'movie' ? progress.data?.resume : null
  const inList = watchlist.data?.inWatchlist ?? false
  const canFind = useCanFindReleases()
  const next = details.mediaType === 'tv' ? nextEpisode(library.data?.continueWatching, details.tmdbId) : null

  function play() {
    if (details.mediaType === 'movie') return openPlay(playTitle(details), resume ?? undefined)
    const target = next ?? { season: firstSeason(details), episode: 1 }
    openPlay(playTitle(details, target), next?.resume)
  }

  return (
    <View style={styles.actions}>
      <Button
        icon="play"
        label={resume ? `Resume from ${formatTime(resume.positionS)}` : next ? `Play S${next.season} E${next.episode}` : details.mediaType === 'tv' ? 'Play the first episode' : 'Play'}
        onPress={play}
      />
      {resume ? <ProgressBar ratio={resume.positionS / (resume.durationS || 1)} style={{ marginTop: space.s }} /> : null}
      <View style={styles.actionRow}>
        <Action icon={inList ? 'checkmark' : 'add'} label={inList ? 'In my list' : 'My list'} on={inList} onPress={() => toggle.mutate(!inList)} />
        {resume ? <Action icon="refresh" label="Start over" onPress={() => openPlay(playTitle(details))} /> : null}
        {canFind ? <Action icon="magnet-outline" label="Releases" onPress={() => openReleases({ title: playTitle(details) })} /> : null}
      </View>
    </View>
  )
}

/** A show: the episode this profile is in (resumed where it stopped), or the one after the last it finished */
function nextEpisode(items: Schemas['ContinueWatchingItem'][] | undefined, tmdbId: number) {
  const item = items?.find((c) => c.mediaType === 'tv' && c.tmdbId === tmdbId)
  if (!item) return null
  const resume = item.kind === 'resume' ? { positionS: item.positionS ?? 0, fileId: item.fileId, infoHash: item.infoHash } : undefined
  return { season: item.season, episode: item.episode, resume }
}

function firstSeason(details: Details) {
  return details.seasons?.find((s) => s.seasonNumber > 0)?.seasonNumber ?? 1
}

function Overview({ details }: { details: Details }) {
  const [open, setOpen] = useState(false)
  if (!details.overview && !details.tagline) return null
  return (
    <Press onPress={() => setOpen(!open)} scale={1} style={styles.overview} accessibilityHint={open ? 'Shows less' : 'Shows the whole summary'}>
      {details.tagline ? <Text style={styles.tagline}>{details.tagline}</Text> : null}
      <Text style={text.body} numberOfLines={open ? undefined : 4}>
        {details.overview}
      </Text>
      {!open && details.overview.length > 220 ? <Text style={[text.small, { color: color.accent, marginTop: space.xs }]}>More</Text> : null}
    </Press>
  )
}

function Seasons({ details }: { details: Details }) {
  const api = useApi()
  const profile = useProfile()
  const base = useImageBase()
  const seasons = useMemo(() => {
    const all = details.seasons ?? []
    const regular = all.filter((s) => s.seasonNumber > 0)
    return regular.length ? [...regular, ...all.filter((s) => s.seasonNumber === 0)] : all
  }, [details.seasons])
  const episodesProgress = useQuery({
    queryKey: ['progress', profile.id, 'tv', details.tmdbId, 'episodes'],
    queryFn: () =>
      unwrap(
        api.GET('/profiles/{profileId}/progress/{mediaType}/{tmdbId}/episodes', {
          params: { path: { profileId: profile.id, mediaType: 'tv', tmdbId: details.tmdbId } },
        }),
      ),
  })
  const [picked, setChosen] = useState<number | null>(null)
  // Until one is picked: the season of the last episode watched, else the first
  const chosen = picked ?? defaultSeason(seasons, episodesProgress.data ?? [])

  const season = useSeason(details.tmdbId, chosen)
  const today = new Date().toISOString().slice(0, 10)

  async function play(seasonNumber: number, episodeNumber: number, name: string) {
    const state = await unwrap(
      api.GET('/profiles/{profileId}/progress/{mediaType}/{tmdbId}', {
        params: { path: { profileId: profile.id, mediaType: 'tv', tmdbId: details.tmdbId }, query: { season: seasonNumber, episode: episodeNumber } },
      }),
    ).catch(() => null)
    openPlay(playTitle(details, { season: seasonNumber, episode: episodeNumber, name }), state?.resume ?? undefined)
  }

  if (!seasons.length) return null
  return (
    <View style={{ marginTop: space.xxl }}>
      <Text style={[text.heading, styles.sectionTitle]}>Episodes</Text>
      {seasons.length > 1 ? (
        <FlatList
          {...ROW_LIST}
          horizontal
          data={seasons}
          keyExtractor={(s) => String(s.seasonNumber)}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: space.l, gap: space.s, paddingBottom: space.s }}
          renderItem={({ item }) => (
            <Chip label={item.seasonNumber === 0 ? 'Specials' : `Season ${item.seasonNumber}`} on={item.seasonNumber === chosen} onPress={() => setChosen(item.seasonNumber)} />
          )}
        />
      ) : null}
      {season.isPending ? <View style={{ height: 200 }} /> : null}
      {(season.data?.episodes ?? []).map((ep, i) => {
        const progress = episodesProgress.data?.find((p) => p.season === ep.seasonNumber && p.episode === ep.episodeNumber)
        const aired = !!ep.airDate && ep.airDate <= today
        return (
          <Animated.View key={`${chosen}-${ep.episodeNumber}`} entering={FadeIn.delay(Math.min(i, 6) * 40).duration(motion.base)}>
            <Press disabled={!aired} onPress={() => play(ep.seasonNumber, ep.episodeNumber, ep.name)} style={[styles.episode, !aired && { opacity: 0.45 }]} accessibilityLabel={`Episode ${ep.episodeNumber}, ${ep.name}`}>
              <View style={styles.still}>
                {ep.stillPath ? <Image source={image(base, ep.stillPath, 'w300')} style={StyleSheet.absoluteFill} contentFit="cover" transition={motion.base} /> : null}
                {aired ? (
                  <View style={styles.stillPlay}>
                    <Ionicons name="play" size={14} color={color.text} style={{ marginLeft: 2 }} />
                  </View>
                ) : null}
                {progress ? <ProgressBar ratio={progress.finished ? 1 : progress.ratio} style={styles.stillProgress} /> : null}
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.episodeHead}>
                  <Text style={styles.episodeNumber}>{ep.episodeNumber}</Text>
                  <Text style={[text.label, { flex: 1 }]} numberOfLines={2}>
                    {ep.name}
                  </Text>
                </View>
                <Text style={[text.tiny, { marginTop: 2 }]}>
                  {aired
                    ? [ep.runtime ? `${ep.runtime} min` : null, progress?.finished ? 'Watched' : null].filter(Boolean).join(', ')
                    : ep.airDate
                      ? `Airs ${new Date(ep.airDate).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`
                      : 'Not announced yet'}
                </Text>
                <Text style={[text.small, { marginTop: space.xs }]} numberOfLines={2}>
                  {ep.overview}
                </Text>
              </View>
            </Press>
          </Animated.View>
        )
      })}
    </View>
  )
}

function Cast({ mediaType, tmdbId }: { mediaType: MediaType; tmdbId: number }) {
  const credits = useCredits(mediaType, tmdbId)
  const base = useImageBase()
  const cast = (credits.data?.cast ?? []).slice(0, 15)
  if (!cast.length) return null
  return (
    <View style={{ marginTop: space.xxl }}>
      <Text style={[text.heading, styles.sectionTitle]}>Cast</Text>
      <FlatList
        {...ROW_LIST}
        horizontal
        data={cast}
        keyExtractor={(c) => c.creditId}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: space.l, gap: space.m }}
        renderItem={({ item }) => (
          <View style={{ width: 84 }}>
            <View style={styles.face}>
              {item.profilePath ? (
                <Image source={image(base, item.profilePath, 'w185')} style={StyleSheet.absoluteFill} contentFit="cover" transition={motion.base} />
              ) : (
                <Text style={styles.initials}>{item.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</Text>
              )}
            </View>
            <Text style={[text.tiny, { color: color.textSoft, marginTop: space.s }]} numberOfLines={2}>
              {item.name}
            </Text>
            {item.character ? (
              <Text style={text.tiny} numberOfLines={1}>
                {item.character}
              </Text>
            ) : null}
          </View>
        )}
      />
    </View>
  )
}

function PluginRows({ details }: { details: Details }) {
  const isMovie = details.mediaType === 'movie'
  const ref = { tmdbId: details.tmdbId, imdbId: details.imdbId, title: details.title, year: details.year ? Number(details.year) : null }
  const rows = useSlotRows(isMovie ? 'core.movie.rows' : 'core.show.rows', isMovie ? { movie: ref } : { show: ref }, `${details.mediaType}${details.tmdbId}`)
  if (!rows.data?.length) return null
  return (
    <View style={{ marginTop: space.xxl }}>
      {rows.data.map((row) => (
        <PluginRowView key={row.plugin + row.key} plugin={row.plugin} row={row} />
      ))}
    </View>
  )
}

function MoreLikeThis({ mediaType, tmdbId }: { mediaType: MediaType; tmdbId: number }) {
  const similar = useSimilar(mediaType, tmdbId)
  const history = useHistory()
  const titles = unseen(similar.data, history.data)
  if (!titles.length) return null
  return (
    <View style={{ marginTop: space.xxl }}>
      <Row label="More like this" titles={titles} scope={`like-${mediaType}-${tmdbId}`} />
    </View>
  )
}

const styles = StyleSheet.create({
  back: { position: 'absolute', left: space.l },
  bar: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: color.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
  // The folded headline: beside Back, a small poster, the title and its year
  barBody: { position: 'absolute', left: space.l + 40 + space.m, right: space.l, flexDirection: 'row', alignItems: 'center', gap: space.m },
  smallPoster: { width: 28, height: 42, borderRadius: radius.s, overflow: 'hidden', backgroundColor: color.surface2, transformOrigin: 'left center' },
  barTitle: { fontFamily: font.display, fontSize: 16, lineHeight: 20, color: color.text, includeFontPadding: false },
  barMeta: { fontFamily: font.medium, fontSize: 12, lineHeight: 15, color: color.textMuted, includeFontPadding: false },
  headline: { flexDirection: 'row', alignItems: 'flex-end', gap: space.l, paddingHorizontal: space.l, marginTop: -POSTER_W * 0.95 },
  poster: {
    width: POSTER_W,
    height: POSTER_W * 1.5,
    borderRadius: radius.m,
    overflow: 'hidden',
    backgroundColor: color.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    transformOrigin: 'left bottom',
  },
  headlineText: { flex: 1, paddingBottom: space.xs, transformOrigin: 'left bottom' },
  meta: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.m, marginTop: space.s },
  metaText: { ...text.small, color: color.textSecondary },
  scores: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.s, paddingHorizontal: space.l, marginTop: space.xl },
  score: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: space.m,
    paddingVertical: space.s,
    borderRadius: radius.m,
    backgroundColor: color.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  scoreValue: { fontFamily: font.display, fontSize: 18, color: color.accent },
  imdb: { backgroundColor: color.imdb, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, alignSelf: 'center' },
  imdbText: { fontFamily: font.display, fontSize: 13, lineHeight: 16, color: color.black, letterSpacing: -0.3 },
  tag: { ...text.tiny, color: color.textSecondary, paddingHorizontal: space.s, paddingVertical: space.xs, borderRadius: radius.s, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  actions: { paddingHorizontal: space.l, marginTop: space.xl },
  actionRow: { flexDirection: 'row', gap: space.s, marginTop: space.l },
  overview: { paddingHorizontal: space.l, marginTop: space.xl },
  tagline: { fontFamily: font.displayBook, fontSize: 17, lineHeight: 23, color: color.text, marginBottom: space.s },
  sectionTitle: { paddingHorizontal: space.l, marginBottom: space.m },
  episode: { flexDirection: 'row', gap: space.m, paddingHorizontal: space.l, paddingVertical: space.m },
  still: { width: 140, height: 79, borderRadius: radius.s, backgroundColor: color.surface2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  stillPlay: { width: 30, height: 30, borderRadius: 15, backgroundColor: color.glass, alignItems: 'center', justifyContent: 'center' },
  stillProgress: { position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: 0 },
  episodeHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.s },
  episodeNumber: { fontFamily: font.display, fontSize: 16, color: color.accent },
  face: { width: 84, height: 104, borderRadius: radius.m, overflow: 'hidden', backgroundColor: color.surface2, alignItems: 'center', justifyContent: 'center' },
  initials: { fontFamily: font.display, fontSize: 22, color: color.textDim },
})

function defaultSeason(seasons: { seasonNumber: number }[], watched: { season: number }[]): number | null {
  if (!seasons.length) return null
  const last = watched.length ? Math.max(...watched.filter((e) => e.season > 0).map((e) => e.season), seasons[0].seasonNumber) : null
  return last != null && seasons.some((s) => s.seasonNumber === last) ? last : seasons[0].seasonNumber
}
