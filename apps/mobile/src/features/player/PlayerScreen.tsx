import { useState } from 'react'
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useKeepAwake } from 'expo-keep-awake'
import { LinearGradient } from 'expo-linear-gradient'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated'
import Ionicons from '@expo/vector-icons/Ionicons'
import type { PlayerController } from '../../core/player/controller'
import type { PlayerExtras } from '../../core/player/extras'
import type { PlaybackSession } from '../../core/playback/session'
import { useStore } from '../../state/hooks'
import { usePlayer, useTakenSession } from '../../state/playback'
import { useSettings } from '../../state/settings'
import { Button, Message, type IconName } from '../../ui/components'
import { Press } from '../../ui/press'
import { color, fade, font, motion, radius, space, text } from '../../ui/theme'
import { endsAt } from './format'
import { LoadingView, SkipButton, Stalled, StatsOnScreen, UpNextCard, metaLine } from './Overlays'
import { SettingsPanel, type SettingsTab } from './SettingsPanel'
import { Timeline } from './Timeline'
import { TracksPanel } from './TracksPanel'

// The player (docs/api/playback.md) on libmpv: every container and codec decoded
// on the phone, drawn as the TV draws its player: the picture, and over it
// only what the moment needs — the title, the timeline and one row of buttons
// at the bottom (Audio & subtitles · back 10 s, play, ahead 10 s · next
// episode, settings), Skip intro and Up next at the right, panels docked at the
// right edge. The screen draws the controllers' state (core/player,
// core/playback) and calls their methods; leaving it stops them all: the last
// position saved, the lease released.

export default function PlayerScreen() {
  const { session: id } = useLocalSearchParams<{ session: string }>()
  const session = useTakenSession(id)
  if (!session) {
    return (
      <View style={styles.page}>
        <Message title="This playback has ended" body="Start it again from the title’s page." action={{ label: 'Back', onPress: () => router.back() }} />
      </View>
    )
  }
  return <Player key={id} session={session} />
}

type Open = { panel: 'tracks' } | { panel: 'settings'; tab: SettingsTab } | null

function Player({ session }: { session: PlaybackSession }) {
  useKeepAwake()
  const { controller, extras, Video } = usePlayer(session)
  const { status } = useStore(session.state)
  const ui = useStore(controller.state)
  const [open, setOpen] = useState<Open>(null)
  // Settings opens on the tab used last, as on the TV
  const [lastTab, setLastTab] = useState<SettingsTab>('style')

  const openSettings = (tab: SettingsTab) => {
    if (tab === 'subtitles') extras.subtitles.open()
    extras.stats.watch(tab === 'stats')
    setLastTab(tab)
    setOpen({ panel: 'settings', tab })
  }
  const openTracks = () => {
    void controller.refreshTracks()
    setOpen({ panel: 'tracks' })
  }

  if (status.phase === 'failed') {
    return (
      <View style={styles.page}>
        <LoadingView session={session} stats={null} ready={false}>
          <Text style={[text.body, styles.failed]}>{status.message}</Text>
          <View style={styles.buttons}>
            <Button kind="secondary" label="Back" onPress={() => router.back()} />
            <Button label="Try again" onPress={() => session.retry()} />
          </View>
        </LoadingView>
      </View>
    )
  }
  const firstFrame = status.phase === 'ready' && (ui.status !== 'loading' || !!ui.error)
  return (
    <View style={styles.page}>
      {status.phase === 'ready' ? <Video /> : null}
      {firstFrame ? (
        <>
          <Surface controller={controller} />
          <Overlay controller={controller} extras={extras} session={session} onTracks={openTracks} onSettings={() => openSettings(lastTab)} />
        </>
      ) : (
        <LoadingView session={session} stats={status.phase === 'preparing' ? status.stats : null} ready={status.phase === 'ready'} message={status.phase === 'preparing' ? status.message : undefined}>
          <View style={styles.buttons}>
            <Button kind="secondary" label="Cancel" onPress={() => router.back()} />
          </View>
        </LoadingView>
      )}
      {open?.panel === 'tracks' ? (
        <TracksPanel
          controller={controller}
          onClose={() => setOpen(null)}
          onFindSubtitles={() => openSettings('subtitles')}
        />
      ) : null}
      {open?.panel === 'settings' ? <SettingsPanel controller={controller} extras={extras} session={session} tab={open.tab} onTab={setLastTab} onClose={() => setOpen(null)} /> : null}
    </View>
  )
}

/**
 * Taps on the video: one shows or hides the controls; two on a side skip, in the middle play / pause.
 * A plain pressable, timed by the controller (PlayerController.press): a gesture-handler tap here
 * activated under the buttons and cancelled their presses.
 */
function Surface({ controller }: { controller: PlayerController }) {
  const { width } = useWindowDimensions()
  const side = (x: number): -1 | 0 | 1 => (x < width / 3 ? -1 : x > (width * 2) / 3 ? 1 : 0)
  const { skip, status } = useStore(controller.state)
  return (
    <Pressable
      style={StyleSheet.absoluteFill}
      onPress={(e) => controller.press(side(e.nativeEvent.pageX))}
      accessibilityLabel="Video"
      accessibilityHint="Tap for the controls; double tap a side to skip ten seconds"
    >
      {status === 'buffering' ? <Stalled /> : null}
      {skip != null ? <SkipBubble seconds={skip} /> : null}
    </Pressable>
  )
}

function SkipBubble({ seconds }: { seconds: number }) {
  const forward = seconds > 0
  return (
    <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(200)} style={[styles.skip, forward ? styles.skipRight : styles.skipLeft]} pointerEvents="none">
      <Animated.View key={seconds} entering={ZoomIn.duration(160)} style={styles.skipDisc}>
        <Ionicons name={forward ? 'play-forward' : 'play-back'} size={26} color={color.text} />
        <Text style={styles.skipText}>
          {forward ? '+' : '−'}
          {Math.abs(seconds)} s
        </Text>
      </Animated.View>
    </Animated.View>
  )
}

type OverlayProps = { controller: PlayerController; extras: PlayerExtras; session: PlaybackSession; onTracks: () => void; onSettings: () => void }

function Overlay({ controller, extras, session, onTracks, onSettings }: OverlayProps) {
  const insets = useSafeAreaInsets()
  const ui = useStore(controller.state)
  const { status: phase, downloaded } = useStore(session.state)
  // Skip intro and Up next's window come from the markers: drawn again when they arrive
  useStore(extras.markers.state)
  const upNext = useStore(extras.upNext.state)
  const settings = useSettings()
  const autoplay = settings.data?.profile?.['player.autoplayNext'] !== false
  const live = phase.phase === 'ready' && phase.stream.live
  const sideX = Math.max(insets.left, insets.right, space.xl) + space.l

  if (ui.error) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.endScrim]}>
        <View style={[styles.endBlock, { paddingHorizontal: sideX, paddingBottom: insets.bottom + space.xxl }]}>
          <Text style={text.hero}>The video stopped</Text>
          <Text style={[text.body, styles.failed]}>{ui.error}</Text>
          <View style={styles.buttons}>
            <Button kind="secondary" label="Back" onPress={() => router.back()} />
            <Button label="Try again" onPress={() => session.retry()} />
          </View>
        </View>
      </View>
    )
  }
  if (ui.status === 'ended') {
    return (
      <View style={[StyleSheet.absoluteFill, styles.endScrim]}>
        <LinearGradient colors={fade.player} style={StyleSheet.absoluteFill} pointerEvents="none" />
        <View style={[styles.endBlock, { paddingHorizontal: sideX, paddingBottom: insets.bottom + space.xxl }]}>
          <Text style={text.hero}>{session.label}</Text>
          <View style={styles.buttons}>
            {upNext.next ? <Button icon="play-skip-forward" label={upNext.looking ? 'Finding a release…' : `Play ${upNext.next.code}`} onPress={() => void extras.playNext()} /> : null}
            <Button kind="secondary" icon="refresh" label="Watch again" onPress={() => controller.replay()} />
            <Button kind={upNext.next ? 'secondary' : 'primary'} label="Back" onPress={() => router.back()} />
          </View>
          {upNext.missing ? <Text style={[text.small, { marginTop: space.m }]}>{upNext.missing}</Text> : null}
        </View>
      </View>
    )
  }

  const remaining = Math.max(0, ui.duration - ui.position)
  const skippable = ui.scrub == null ? extras.markers.skippable(ui.position) : null
  const window = extras.markers.upNextWindow(ui.duration)
  const upNextShown = !!upNext.next && !upNext.dismissed && !live && ui.duration > 0 && remaining <= window
  const meta = metaLine(session)

  return (
    <>
      {ui.controls ? (
        <Animated.View entering={FadeIn.duration(motion.base)} exiting={FadeOut.duration(motion.slow)} style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <LinearGradient colors={fade.playerTop} style={styles.shadeTop} pointerEvents="none" />
          <LinearGradient colors={fade.player} style={styles.shadeBottom} pointerEvents="none" />
          <View style={[styles.top, { paddingTop: insets.top + space.m, paddingHorizontal: sideX - space.s }]} pointerEvents="box-none">
            <Control icon="arrow-back" label="Back" onPress={() => router.back()} />
          </View>
          <View style={[styles.bottom, { paddingHorizontal: sideX, paddingBottom: insets.bottom + space.m }]} pointerEvents="box-none">
            <View style={styles.titleBlock} pointerEvents="none">
              {live ? <Text style={styles.liveMark}>Live</Text> : null}
              <Text style={text.title} numberOfLines={1}>
                {session.label}
              </Text>
              {meta ? (
                <Text style={styles.meta} numberOfLines={1}>
                  {meta}
                </Text>
              ) : null}
            </View>
            {!live ? (
              <Timeline
                position={ui.position}
                duration={ui.duration}
                bufferedTo={ui.bufferedTo}
                downloaded={downloaded}
                scrub={ui.scrub}
                hint={ui.duration ? `Ends at ${endsAt(remaining, ui.tuning.speed)}` : ''}
                onScrub={(s) => controller.scrubTo(s)}
                onRelease={() => controller.endScrub()}
              />
            ) : null}
            <View style={styles.row}>
              <View style={styles.group}>
                <Control icon="chatbox-ellipses-outline" label="Audio & subtitles" onPress={onTracks} />
              </View>
              <View style={[styles.group, styles.center]}>
                {!live ? <Control icon="play-back" caption="10" label="10 s back" onPress={() => controller.skip(-1)} /> : null}
                <Control icon={ui.status === 'paused' ? 'play' : 'pause'} large label={ui.status === 'paused' ? 'Play' : 'Pause'} onPress={() => controller.togglePlay()} />
                {!live ? <Control icon="play-forward" caption="10" label="10 s ahead" onPress={() => controller.skip(1)} /> : null}
              </View>
              <View style={[styles.group, styles.end]}>
                {upNext.next ? <Control icon="play-skip-forward" label={upNext.looking ? 'Finding a release…' : 'Next episode'} onPress={() => void extras.playNext()} /> : null}
                <Control icon="options-outline" label="Settings" onPress={onSettings} />
              </View>
            </View>
          </View>
        </Animated.View>
      ) : null}
      <StatsOnScreen controller={controller} extras={extras} />
      {skippable && !upNextShown ? (
        <SkipButton
          marker={skippable}
          raised={ui.controls}
          onPress={() => {
            extras.markers.dismiss(skippable)
            if (skippable.end != null) controller.seekTo(skippable.end)
          }}
        />
      ) : null}
      {upNextShown ? <UpNextCard extras={extras} remaining={remaining} window={window} raised={ui.controls} autoplay={autoplay} /> : null}
    </>
  )
}

/** A button of the controls, as the TV's icon buttons: the icon alone, Play larger in a disc */
function Control({ icon, onPress, label, large, caption }: { icon: IconName; onPress: () => void; label: string; large?: boolean; caption?: string }) {
  return (
    <Press onPress={onPress} hitSlop={10} accessibilityLabel={label} accessibilityRole="button" style={[styles.control, large && styles.controlLarge]}>
      <Ionicons name={icon} size={large ? 34 : 26} color={large ? color.onFocus : color.text} style={large && icon === 'play' ? { marginLeft: 3 } : undefined} />
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </Press>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.black },
  failed: { color: color.textSecondary, marginTop: space.m },
  buttons: { flexDirection: 'row', gap: space.m, marginTop: space.xl },
  endScrim: { backgroundColor: color.scrim },
  endBlock: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end' },
  shadeTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 120 },
  shadeBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '75%' },
  top: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  titleBlock: { marginBottom: space.s },
  liveMark: {
    alignSelf: 'flex-start',
    marginBottom: space.s,
    paddingHorizontal: space.s + 2,
    paddingVertical: 2,
    borderRadius: radius.s,
    overflow: 'hidden',
    backgroundColor: color.live,
    color: color.onFocus,
    fontFamily: font.display,
    fontSize: 12,
  },
  meta: { ...text.body, color: color.textSecondary, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: space.xs },
  group: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.m },
  center: { justifyContent: 'center', gap: space.xl },
  end: { justifyContent: 'flex-end' },
  control: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  controlLarge: { width: 60, height: 60, borderRadius: 30, backgroundColor: color.focus },
  caption: { position: 'absolute', bottom: 2, fontFamily: font.semibold, fontSize: 9, color: color.text },
  skip: { position: 'absolute', top: 0, bottom: 0, width: '40%', alignItems: 'center', justifyContent: 'center' },
  skipLeft: { left: 0, borderTopRightRadius: 400, borderBottomRightRadius: 400, backgroundColor: color.surface1 },
  skipRight: { right: 0, borderTopLeftRadius: 400, borderBottomLeftRadius: 400, backgroundColor: color.surface1 },
  skipDisc: { alignItems: 'center', gap: space.xs },
  skipText: { fontFamily: font.semibold, fontSize: 16, color: color.text },
})
