import type { ReactNode } from 'react'
import { ActivityIndicator, FlatList, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { Image } from 'expo-image'
import { router } from 'expo-router'
import Ionicons from '@expo/vector-icons/Ionicons'
import Animated from 'react-native-reanimated'
import { morph } from './morph'
import { color, font, motion, radius, space, text } from './theme'
import { Leader, SkeletonRow } from './loading'
import { Press } from './press'
import { image, useImageBase, type Title } from '../lib/catalog'
import { useMorphTag } from '../state/boundary'

export type IconName = React.ComponentProps<typeof Ionicons>['name']

export function Button({
  label,
  icon,
  onPress,
  kind = 'primary',
  disabled,
  style,
}: {
  label: string
  icon?: IconName
  onPress: () => void
  kind?: 'primary' | 'secondary' | 'quiet'
  disabled?: boolean
  style?: ViewStyle
}) {
  const primary = kind === 'primary'
  const ink = primary ? color.onAccent : color.text
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={[styles.button, primary ? styles.buttonPrimary : kind === 'secondary' ? styles.buttonSecondary : styles.buttonQuiet, disabled && { opacity: 0.45 }, style]}
    >
      {icon && <Ionicons name={icon} size={20} color={ink} />}
      <Text style={[styles.buttonLabel, { color: ink }]}>{label}</Text>
    </Press>
  )
}

/** A round action under the title (My list, Watched…): an icon over its short name */
/** `busy`: its work is under way (a plugin asked): a spinner instead of the icon, taps ignored */
export function Action({ icon, label, on, busy, onPress }: { icon: IconName; label: string; on?: boolean; busy?: boolean; onPress: () => void }) {
  return (
    <Press onPress={busy ? () => {} : onPress} style={styles.action} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on, busy }}>
      <View style={[styles.actionDisc, on && styles.actionDiscOn]}>
        {busy ? <ActivityIndicator color={on ? color.onAccent : color.accent} /> : <Ionicons name={icon} size={22} color={on ? color.onAccent : color.text} />}
      </View>
      <Text style={styles.actionLabel} numberOfLines={1}>
        {label}
      </Text>
    </Press>
  )
}

export function IconButton({ icon, onPress, size = 24, label, glass }: { icon: IconName; onPress: () => void; size?: number; label: string; glass?: boolean }) {
  return (
    <Press onPress={onPress} hitSlop={12} accessibilityLabel={label} accessibilityRole="button" style={[styles.iconButton, glass && styles.iconGlass]}>
      <Ionicons name={icon} size={size} color={color.text} />
    </Press>
  )
}

/** Waiting: the countdown leader (ui/loading.tsx) */
export function Loading({ label }: { label?: string }) {
  return <Leader label={label} />
}

export function Message({ title, body, action, icon }: { title: string; body?: string; icon?: IconName; action?: { label: string; onPress: () => void } }) {
  return (
    <View style={styles.center}>
      {icon ? <Ionicons name={icon} size={36} color={color.textMuted} style={{ marginBottom: space.l }} /> : null}
      <Text style={[text.heading, { textAlign: 'center' }]}>{title}</Text>
      {body ? <Text style={[text.body, { textAlign: 'center', marginTop: space.s, color: color.textMuted, maxWidth: 320 }]}>{body}</Text> : null}
      {action ? <Button label={action.label} onPress={action.onPress} style={{ marginTop: space.xl }} /> : null}
    </View>
  )
}

export function ProgressBar({ ratio, style }: { ratio: number; style?: ViewStyle }) {
  return (
    <View style={[styles.track, style]}>
      <View style={[styles.fill, { width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }]} />
    </View>
  )
}

/** expo-image as a view Reanimated can morph */
const AnimatedImage = Animated.createAnimatedComponent(Image)

/**
 * A picture at either end of a morph, carrying the morph's tag itself: a
 * shared transition moves the tagged view alone, never what is inside it, so
 * the picture must be that view. Kept decoded in memory at its own size, so
 * the screen being opened has it at once. `fade`: how long one that wasn't
 * loaded takes to appear; `round`: its container's corners.
 */
export function MorphImage({ uri, tag, fade = 0, round = 0 }: { uri: string | undefined; tag?: string; fade?: number; round?: number }) {
  // Always there, even before its picture is known: a view inserted later among its siblings can
  // land after the gradients meant to be over it
  return (
    <AnimatedImage
      source={uri ?? null}
      style={[StyleSheet.absoluteFill, round ? { borderRadius: round } : null]}
      contentFit="cover"
      cachePolicy="memory-disk"
      allowDownscaling={false}
      transition={fade}
      sharedTransitionTag={tag}
      sharedTransitionStyle={tag ? morph : undefined}
    />
  )
}

/** The poster's morph into the title page: the same tag on both screens (ui/morph.ts) */
export const posterTransition = morph

export function posterTag(scope: string, mediaType: string, tmdbId: number) {
  return `poster-${scope}-${mediaType}-${tmdbId}`
}

/** Opens a title; `from` is the tapped poster's tag and picture, drawn at once while the page loads */
export function openTitle(mediaType: string, tmdbId: number, from?: { tag: string; posterPath?: string | null; backdropPath?: string | null; title?: string }) {
  router.push({
    pathname: '/title/[mediaType]/[id]',
    params: {
      mediaType,
      id: String(tmdbId),
      ...(from ? { tag: from.tag, poster: from.posterPath ?? '', backdrop: from.backdropPath ?? '', name: from.title ?? '' } : {}),
    },
  })
}

export const POSTER_WIDTH = 116

/**
 * Horizontal rows draw only what is near the screen: a phone sees three or four posters of each.
 * Never removeClippedSubviews (on by default on Android): a tab that is hidden clips everything,
 * its posters are detached, and expo-image doesn't always draw them again when the tab comes back.
 */
export const ROW_LIST = { initialNumToRender: 5, maxToRenderPerBatch: 4, windowSize: 3, removeClippedSubviews: false } as const

export function Poster({
  title,
  path,
  width = POSTER_WIDTH,
  ratio,
  tag,
  onPress,
}: {
  title: string
  path: string | null | undefined
  width?: number
  ratio?: number
  tag?: string
  onPress: () => void
}) {
  const base = useImageBase()
  const morph = useMorphTag(tag)
  return (
    <Press onPress={() => morph.open(onPress)} style={{ width }} accessibilityLabel={title} accessibilityRole="button">
      <View style={[styles.poster, { width, height: width * 1.5 }]}>
        {path ? (
          <MorphImage key={morph.key} uri={image(base, path, 'w342')} tag={morph.tag} fade={motion.base} round={radius.m} />
        ) : (
          <Text style={[styles.posterTitle]} numberOfLines={4}>
            {title}
          </Text>
        )}
      </View>
      {ratio != null ? <ProgressBar ratio={ratio} style={{ marginTop: space.xs }} /> : null}
    </Press>
  )
}

/**
 * A title to choose from a row or a grid: its poster and, under it, its name on one line, its year
 * and its score (TMDB's, once enough people voted).
 */
export function TitleCard({ title, scope, width = POSTER_WIDTH }: { title: Title; scope: string; width?: number }) {
  const tag = posterTag(scope, title.mediaType, title.tmdbId)
  return (
    <View style={{ width }}>
      <Poster
        title={title.title}
        path={title.posterPath}
        width={width}
        tag={tag}
        onPress={() => openTitle(title.mediaType, title.tmdbId, { tag, posterPath: title.posterPath, backdropPath: title.backdropPath, title: title.title })}
      />
      <TitleCaption title={title} />
    </View>
  )
}

/** Height of a TitleCaption: rows that align things to the poster's foot leave it out */
export const CAPTION_HEIGHT = space.s + 17 + space.xxs + 16

/** Under a poster: the name on one line, then the year and the score */
export function TitleCaption({ title }: { title: Pick<Title, 'title' | 'year' | 'voteAverage' | 'voteCount'> }) {
  const scored = title.voteCount > 0 && title.voteAverage > 0
  return (
    <>
      <Text style={styles.cardName} numberOfLines={1}>
        {title.title}
      </Text>
      <View style={styles.cardMeta}>
        <Text style={styles.cardYear}>{title.year ?? ''}</Text>
        {scored ? (
          <View style={styles.cardScore} accessibilityLabel={`Rated ${title.voteAverage.toFixed(1)} out of 10`}>
            <Ionicons name="star" size={10} color={color.accentDeep} />
            <Text style={styles.cardScoreValue}>{title.voteAverage.toFixed(1)}</Text>
          </View>
        ) : null}
      </View>
    </>
  )
}

/** A row heading: Futura, sentence case; an optional line under it says why the row is here */
export function RowHeading({ title, why, right }: { title: string; why?: string; right?: ReactNode }) {
  return (
    <View style={styles.rowHeading}>
      <View style={{ flex: 1 }}>
        <Text style={text.heading} numberOfLines={1}>
          {title}
        </Text>
        {why ? (
          <Text style={[text.small, { marginTop: 2 }]} numberOfLines={1}>
            {why}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  )
}

export function SeeAll({ onPress }: { onPress: () => void }) {
  return (
    <Press onPress={onPress} hitSlop={10} scale={0.94} accessibilityRole="button" accessibilityLabel="See all" style={styles.seeAll}>
      <Text style={styles.seeAllText}>See all</Text>
      <Ionicons name="chevron-forward" size={14} color={color.accent} />
    </Press>
  )
}

/** Placeholder tiles while a row loads: the shapes it will have, the light passing over them */
export function RowSkeleton({ width = POSTER_WIDTH, ratio = 1.5, index = 0 }: { width?: number; ratio?: number; count?: number; index?: number }) {
  return <SkeletonRow width={width} ratio={ratio} index={index} />
}

export function Row({
  label,
  why,
  titles,
  loading,
  scope,
  onSeeAll,
}: {
  label: string
  why?: string
  titles: Title[] | undefined
  loading?: boolean
  scope: string
  /** The whole catalogue behind the row (the heading's "See all") */
  onSeeAll?: () => void
}) {
  if (!loading && !titles?.length) return null
  return (
    <View style={styles.row}>
      <RowHeading title={label} why={why} right={onSeeAll ? <SeeAll onPress={onSeeAll} /> : undefined} />
      {loading ? (
        <RowSkeleton />
      ) : (
        <FlatList
          {...ROW_LIST}
          horizontal
          data={titles}
          keyExtractor={(t) => t.mediaType + t.tmdbId}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.rowList}
          renderItem={({ item }) => <TitleCard title={item} scope={scope} />}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  cardName: { marginTop: space.s, fontFamily: font.semibold, fontSize: 13, lineHeight: 17, color: color.textSoft, includeFontPadding: false },
  cardMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: space.xxs, minHeight: 16 },
  cardYear: { fontFamily: font.medium, fontSize: 12, lineHeight: 16, color: color.textDim },
  cardScore: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  cardScoreValue: { fontFamily: font.medium, fontSize: 12, lineHeight: 16, color: color.textMuted, fontVariant: ['tabular-nums'] },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.s,
    paddingHorizontal: space.xl,
    minHeight: 50,
    borderRadius: radius.pill,
  },
  buttonPrimary: { backgroundColor: color.accent },
  buttonSecondary: { backgroundColor: color.surface1, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  buttonQuiet: { backgroundColor: 'transparent' },
  buttonLabel: { fontFamily: font.semibold, fontSize: 16 },
  action: { alignItems: 'center', width: 76, gap: space.s },
  actionDisc: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
  },
  actionDiscOn: { backgroundColor: color.accent, borderColor: color.accent },
  actionLabel: { ...text.tiny, color: color.textSecondary },
  iconButton: { padding: space.xs, alignItems: 'center', justifyContent: 'center' },
  iconGlass: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.glass },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl },
  track: { height: 3, borderRadius: 2, backgroundColor: color.progressTrack, overflow: 'hidden' },
  fill: { height: 3, borderRadius: 2, backgroundColor: color.progress },
  poster: { borderRadius: radius.m, backgroundColor: color.placeholder, overflow: 'hidden', justifyContent: 'flex-end' },
  posterTitle: { ...text.small, color: color.textSecondary, padding: space.s },
  row: { marginBottom: space.xxl },
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingLeft: space.m, paddingBottom: 2 },
  seeAllText: { fontFamily: font.semibold, fontSize: 14, color: color.accent },
  rowHeading: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: space.l, marginBottom: space.m },
  rowList: { paddingHorizontal: space.l, gap: space.s + 2 },
})
