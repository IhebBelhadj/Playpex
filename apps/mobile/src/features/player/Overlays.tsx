import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LinearGradient } from 'expo-linear-gradient'
import { Image } from 'expo-image'
import Ionicons from '@expo/vector-icons/Ionicons'
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import type { PlayerController } from '../../core/player/controller'
import type { PlayerExtras } from '../../core/player/extras'
import { skipLabel } from '../../core/player/markers'
import type { PlaybackSession } from '../../core/playback/session'
import { formatTime, type Marker, type TorrentStats } from '../../core/services/playback'
import { image, useImageBase } from '../../lib/catalog'
import { useStore } from '../../state/hooks'
import { Press } from '../../ui/press'
import { color, fade, font, motion, radius, space, text } from '../../ui/theme'
import { StatsFacts } from './SettingsPanel'
import { formatBytes } from './format'

// What the TV's player shows over the picture besides its controls: before
// the first frame, the steps a torrent goes through; "Skip intro"; Up next;
// the stats while watching. Bottom-right overlays rise above the controls
// when they are shown.

/** How far the bottom-right overlays sit above the controls when those are shown */
export const ABOVE_CONTROLS = 196

const TORRENT_STAGES = ['Starting the torrent', 'Finding peers', 'Reading the torrent', 'Downloading the start']

/** The steps before the first frame, and the one under way */
export function stagesOf(session: PlaybackSession, stats: TorrentStats | null, ready: boolean): { stages: string[]; stage: number } {
  const source = session.source
  if (source.format === 'hls' || source.format === 'live') return { stages: ['Opening the stream'], stage: 0 }
  if (source.ref) return { stages: ['Opening the file on the server'], stage: 0 }
  if (ready) return { stages: TORRENT_STAGES, stage: 3 }
  return { stages: TORRENT_STAGES, stage: !stats ? 0 : !stats.peers?.total ? 1 : !stats.metadata ? 2 : 3 }
}

export function metaLine(session: PlaybackSession): string {
  const t = session.title
  return t.episodeName ?? (t.year ? String(t.year) : '')
}

/** Before the first frame: the title at the bottom, as on the TV, and the steps */
export function LoadingView({ session, stats, ready, message, children }: { session: PlaybackSession; stats: TorrentStats | null; ready: boolean; message?: string; children?: React.ReactNode }) {
  const insets = useSafeAreaInsets()
  const { stages, stage } = stagesOf(session, stats, ready)
  const meta = metaLine(session)
  return (
    <Animated.View exiting={FadeOut.duration(motion.base)} style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <LinearGradient colors={fade.player} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <View style={[styles.loading, { paddingLeft: Math.max(insets.left, space.xl) + space.l, paddingRight: Math.max(insets.right, space.xl) + space.l, paddingBottom: insets.bottom + space.xxl }]} pointerEvents="box-none">
        <ActivityIndicator color={color.text} size="large" style={styles.spinner} />
        <Text style={text.hero} numberOfLines={2}>
          {session.label}
        </Text>
        {meta ? <Text style={styles.meta}>{meta}</Text> : null}
        <View style={styles.stages}>
          {stages.map((s, i) => (
            <View key={s} style={[styles.stageItem, i < stage && styles.stageDone, i === stage && styles.stageNow]}>
              <Text style={[styles.stageText, i < stage && styles.stageTextDone, i === stage && styles.stageTextNow]} numberOfLines={1}>
                {s}
              </Text>
            </View>
          ))}
        </View>
        {stats ? <Swarm stats={stats} /> : message ? <Text style={styles.swarmLine}>{message}</Text> : null}
        {children}
      </View>
    </Animated.View>
  )
}

function Swarm({ stats }: { stats: TorrentStats }) {
  const peers = stats.peers?.total ?? 0
  return (
    <Text style={styles.swarmLine}>
      <Text style={styles.swarmValue}>{peers}</Text> {peers === 1 ? 'peer' : 'peers'}
      {'   '}
      <Text style={styles.swarmValue}>{formatBytes(stats.speed?.down ?? 0)}</Text>/s{'   '}
      <Text style={styles.swarmValue}>{formatBytes(stats.traffic?.down ?? 0)}</Text> downloaded
    </Text>
  )
}

/** A stall once playing: the spinner and a line in the middle, the picture stays */
export function Stalled() {
  return (
    <View style={styles.stalled} pointerEvents="none">
      <ActivityIndicator color={color.text} size="large" />
      <Text style={styles.stalledText}>Loading more of the video</Text>
    </View>
  )
}

/** A plugin marked an intro / recap here: one tap skips it */
export function SkipButton({ marker, raised, onPress }: { marker: Marker; raised: boolean; onPress: () => void }) {
  const insets = useSafeAreaInsets()
  return (
    <Animated.View
      entering={FadeIn.duration(motion.base)}
      exiting={FadeOut.duration(motion.fast)}
      layout={LinearTransition.duration(motion.slow)}
      style={[styles.corner, { right: Math.max(insets.right, space.xl) + space.l, bottom: insets.bottom + (raised ? ABOVE_CONTROLS : space.xxl) }]}
    >
      <Press onPress={onPress} style={styles.skip} accessibilityRole="button">
        <Text style={styles.skipText}>{skipLabel(marker)}</Text>
        <Ionicons name="play-skip-forward" size={18} color={color.onFocus} />
      </Press>
    </Animated.View>
  )
}

/** Up next (episodes, the last 40 s or from the credits): its still, a countdown, tap to play */
export function UpNextCard({ extras, remaining, window, raised, autoplay }: { extras: PlayerExtras; remaining: number; window: number; raised: boolean; autoplay: boolean }) {
  const insets = useSafeAreaInsets()
  const base = useImageBase()
  const { next, source, looking, missing } = useStore(extras.upNext.state)
  if (!next) return null
  const still = image(base, next.episode.stillPath, 'w300')
  const done = Math.min(1, Math.max(0, 1 - remaining / window))
  const hint = source
    ? autoplay
      ? `Plays in ${formatTime(remaining)}. Tap to play now.`
      : 'Tap to play it now.'
    : (missing ?? (looking ? 'Finding a release…' : 'Tap to find a release'))
  return (
    <Animated.View
      entering={FadeIn.duration(motion.base)}
      exiting={FadeOut.duration(motion.fast)}
      layout={LinearTransition.duration(motion.slow)}
      style={[styles.corner, { right: Math.max(insets.right, space.xl) + space.l, bottom: insets.bottom + (raised ? ABOVE_CONTROLS : space.xxl) }]}
    >
      <Press onPress={() => void extras.playNext()} scale={0.98} style={styles.upNext} accessibilityRole="button" accessibilityLabel={`Up next: ${next.code} ${next.episode.name}`}>
        <View style={styles.still}>{still ? <Image source={{ uri: still }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}</View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.upNextLabel}>Up next</Text>
          <Text style={styles.upNextName} numberOfLines={1}>
            {next.code} {next.episode.name}
          </Text>
          {source && autoplay ? (
            <View style={styles.countdown}>
              <View style={[styles.countdownDone, { width: `${done * 100}%` }]} />
            </View>
          ) : null}
          <Text style={styles.upNextHint} numberOfLines={2}>
            {hint}
          </Text>
        </View>
        <Press onPress={() => extras.upNext.dismiss()} hitSlop={12} accessibilityLabel="Dismiss Up next" accessibilityRole="button" style={styles.dismiss}>
          <Ionicons name="close" size={18} color={color.textSecondary} />
        </Press>
      </Press>
    </Animated.View>
  )
}

/** Settings › Stats › "Show on screen while watching" */
export function StatsOnScreen({ controller, extras }: { controller: PlayerController; extras: PlayerExtras }) {
  const insets = useSafeAreaInsets()
  const { onScreen } = useStore(extras.stats.state)
  if (!onScreen) return null
  return (
    <View style={[styles.stats, { top: insets.top + 72, right: Math.max(insets.right, space.xl) + space.l }]} pointerEvents="none">
      <Text style={styles.statsTitle}>Stats</Text>
      <StatsFacts controller={controller} extras={extras} session={controller.session} />
    </View>
  )
}

const styles = StyleSheet.create({
  loading: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end' },
  spinner: { alignSelf: 'flex-start', marginBottom: space.l },
  meta: { ...text.body, color: color.textSecondary, marginTop: space.xs },
  stages: { flexDirection: 'row', gap: space.m, marginTop: space.xl },
  stageItem: { flex: 1, maxWidth: 190, paddingTop: space.s, borderTopWidth: 3, borderTopColor: color.progressTrack },
  stageDone: { borderTopColor: color.textSecondary },
  stageNow: { borderTopColor: color.progress },
  stageText: { fontFamily: font.medium, fontSize: 12, color: color.textDim },
  stageTextDone: { color: color.textMuted },
  stageTextNow: { color: color.text },
  swarmLine: { marginTop: space.m, fontFamily: font.body, fontSize: 13, color: color.textMuted, fontVariant: ['tabular-nums'] },
  swarmValue: { fontFamily: font.semibold, color: color.textSoft },
  stalled: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: space.m },
  stalledText: { ...text.label, textShadowColor: color.black, textShadowRadius: 6 },
  corner: { position: 'absolute' },
  skip: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.xl, paddingVertical: space.m, borderRadius: radius.l, backgroundColor: color.focus },
  skipText: { fontFamily: font.display, fontSize: 17, color: color.onFocus },
  upNext: { flexDirection: 'row', gap: space.m, width: 380, padding: space.m, borderRadius: radius.l, backgroundColor: color.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  still: { width: 128, height: 72, borderRadius: radius.m, overflow: 'hidden', backgroundColor: color.surface3 },
  upNextLabel: { ...text.tiny, color: color.textMuted },
  upNextName: { fontFamily: font.display, fontSize: 15, color: color.text, marginTop: 2, marginBottom: space.s, paddingRight: space.l },
  countdown: { height: 4, borderRadius: radius.pill, backgroundColor: color.progressTrack, overflow: 'hidden' },
  countdownDone: { height: '100%', backgroundColor: color.progress },
  upNextHint: { ...text.tiny, color: color.textSecondary, marginTop: space.s },
  dismiss: { position: 'absolute', top: 0, right: 0 },
  stats: { position: 'absolute', minWidth: 280, padding: space.l, borderRadius: radius.m, backgroundColor: color.dark86 },
  statsTitle: { fontFamily: font.display, fontSize: 15, color: color.text, marginBottom: space.s },
})
