import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { usePathname } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated'
import Ionicons from '@expo/vector-icons/Ionicons'
import type { CastScreen } from '../../core/cast/caster'
import { useCast, useContinueOnPhone } from '../../state/cast'
import { useBackPress } from '../../state/hooks'
import { TAB_BAR_HEIGHT } from '../../ui/chrome'
import { Button, ProgressBar, type IconName } from '../../ui/components'
import { Press } from '../../ui/press'
import { Sheet } from '../../ui/sheet'
import { useToast } from '../../ui/toast'
import { color, radius, space, text } from '../../ui/theme'

// Casting from the phone (docs/cast-plan.md §4.3): the top bar's cast button
// (where Play sends: this phone or a screen), the mini player over the tabs
// while a cast runs, and its remote (pause, ± seconds, stop, Continue on
// phone). The player's own "Play on a screen" uses ScreenSheet too.

const STATE: Record<string, string> = { opening: 'Opening', playing: 'Playing', paused: 'Paused', buffering: 'Loading', ended: 'Ended', failed: 'Couldn’t play' }

function screenIcon(kind: CastScreen['kind']): IconName {
  return kind === 'mobile' ? 'phone-portrait-outline' : kind === 'web' ? 'laptop-outline' : 'tv-outline'
}

function clock(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return ''
  const t = Math.max(0, Math.floor(s))
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

function Row({ icon, title, line, chosen, onPress }: { icon: IconName; title: string; line: string; chosen: boolean; onPress: () => void }) {
  return (
    <Press onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: chosen }} accessibilityLabel={title} style={[styles.row, chosen && styles.rowChosen]}>
      <Ionicons name={icon} size={24} color={chosen ? color.accent : color.textMuted} />
      <View style={{ flex: 1 }}>
        <Text style={text.label} numberOfLines={1}>
          {title}
        </Text>
        <Text style={text.small} numberOfLines={1}>
          {line}
        </Text>
      </View>
      {chosen ? <Ionicons name="checkmark" size={20} color={color.accent} /> : null}
    </Press>
  )
}

/** The screens to pick from; `here`: a first row for this phone */
export function ScreenSheet({ title, here, chosen, onPick, onClose }: { title: string; here?: boolean; chosen?: string | null; onPick: (s: CastScreen | null) => void; onClose: () => void }) {
  const { caster, state } = useCast()
  useBackPress(true, onClose)
  return (
    <Sheet label={title} onClose={onClose}>
      <View style={styles.sheet}>
        <Text style={[text.heading, styles.heading]}>{title}</Text>
        {here ? <Row icon="phone-portrait-outline" title="This phone" line="Plays here" chosen={!chosen} onPress={() => onPick(null)} /> : null}
        {state.screens.map((s) => (
          <Row
            key={s.deviceId}
            icon={screenIcon(s.kind)}
            title={s.name}
            line={s.playing ? [STATE[s.playing.state], s.playing.title].filter(Boolean).join(' · ') : 'Nothing playing'}
            chosen={chosen === s.deviceId}
            onPress={() => onPick(s)}
          />
        ))}
        {state.loaded && !state.screens.length ? (
          <Text style={[text.small, styles.empty]}>No screen is on. Open Playpex TV on a screen; its Settings › Casting lets devices cast to it.</Text>
        ) : null}
        <Press onPress={() => void caster?.refresh()} accessibilityRole="button" accessibilityLabel="Look again" style={styles.again}>
          <Ionicons name="refresh" size={16} color={color.textMuted} />
          <Text style={text.small}>Look again</Text>
        </Press>
      </View>
    </Sheet>
  )
}

/** The top bar's cast button: gold while Play sends to a screen */
export function CastButton() {
  const { caster, state } = useCast()
  const [open, setOpen] = useState(false)
  if (!caster) return null
  const on = !!state.target && state.screens.some((s) => s.deviceId === state.target!.deviceId)
  return (
    <>
      <Press
        onPress={() => {
          void caster.refresh()
          setOpen(true)
        }}
        hitSlop={10}
        scale={0.9}
        accessibilityRole="button"
        accessibilityLabel={on ? `Playing on ${state.target!.name}` : 'Play on a screen'}
        style={styles.castButton}
      >
        <Ionicons name={on ? 'tv' : 'tv-outline'} size={21} color={on ? color.accent : color.text} />
      </Press>
      {open ? (
        <ScreenSheet
          title="Play on"
          here
          chosen={on ? state.target!.deviceId : null}
          onClose={() => setOpen(false)}
          onPick={(s) => {
            caster.choose(s)
            setOpen(false)
          }}
        />
      ) : null}
    </>
  )
}

// screens the bar stays off: the player, the source list, before a profile is chosen
const HIDDEN = ['/player', '/play', '/share', '/connect', '/pair', '/profiles']

/** The mini player: what this phone cast, over the tabs; a tap opens its remote */
export function CastBar() {
  const { caster, state } = useCast()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const [remote, setRemote] = useState(false)
  const cast = state.cast
  if (!caster || !cast || HIDDEN.some((p) => pathname.startsWith(p))) return null
  const screen = state.screens.find((s) => s.deviceId === cast.deviceId)
  const paused = cast.state === 'paused'
  const ratio = cast.durationS && cast.positionS != null ? cast.positionS / cast.durationS : 0
  return (
    <>
      <Animated.View entering={FadeInDown.duration(220)} exiting={FadeOutDown.duration(180)} style={[styles.bar, { bottom: insets.bottom + TAB_BAR_HEIGHT + space.s }]}>
        <Press onPress={() => setRemote(true)} scale={0.98} accessibilityRole="button" accessibilityLabel={`${cast.title}, on ${screen?.name ?? 'a screen'}: open the remote`} style={styles.barMain}>
          <Ionicons name={screen ? screenIcon(screen.kind) : 'tv-outline'} size={22} color={color.accent} />
          <View style={{ flex: 1 }}>
            <Text style={text.label} numberOfLines={1}>
              {cast.title}
            </Text>
            <Text style={text.tiny} numberOfLines={1}>
              {[screen?.name, STATE[cast.state], cast.positionS != null ? clock(cast.positionS) + (cast.durationS ? ' / ' + clock(cast.durationS) : '') : null].filter(Boolean).join(' · ')}
            </Text>
          </View>
        </Press>
        <Press onPress={() => void caster.command('toggle')} hitSlop={8} accessibilityRole="button" accessibilityLabel={paused ? 'Play' : 'Pause'} style={styles.barButton}>
          <Ionicons name={paused ? 'play' : 'pause'} size={24} color={color.text} />
        </Press>
        <Press onPress={() => void caster.command('stop')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Stop" style={styles.barButton}>
          <Ionicons name="stop" size={20} color={color.text} />
        </Press>
        {ratio > 0 ? <ProgressBar ratio={ratio} style={styles.barProgress} /> : null}
      </Animated.View>
      {remote ? <CastRemote onClose={() => setRemote(false)} /> : null}
    </>
  )
}

/** The remote of this phone's cast */
function CastRemote({ onClose }: { onClose: () => void }) {
  const { caster, state } = useCast()
  const continueOnPhone = useContinueOnPhone()
  const toast = useToast()
  useBackPress(true, onClose)
  const cast = state.cast
  if (!caster || !cast) return null
  const screen = state.screens.find((s) => s.deviceId === cast.deviceId)
  const paused = cast.state === 'paused'
  const send = (action: 'toggle' | 'seekBy' | 'stop', deltaS?: number) =>
    caster.command(action, deltaS != null ? { deltaS } : undefined).catch((e: Error) => toast(e.message, { tone: 'error' }))
  return (
    <Sheet label="Remote" onClose={onClose}>
      <View style={styles.sheet}>
        <Text style={text.small}>On {screen?.name ?? 'a screen'}</Text>
        <Text style={[text.title, { marginTop: space.xs }]} numberOfLines={2}>
          {cast.title}
        </Text>
        <Text style={[text.small, { marginTop: space.xs }]}>
          {STATE[cast.state]}
          {cast.error ? ` · ${cast.error}` : ''}
        </Text>
        <View style={styles.time}>
          <ProgressBar ratio={cast.durationS && cast.positionS != null ? cast.positionS / cast.durationS : 0} />
          <View style={styles.times}>
            <Text style={text.tiny}>{clock(cast.positionS)}</Text>
            <Text style={text.tiny}>{cast.durationS ? '−' + clock(cast.durationS - (cast.positionS ?? 0)) : ''}</Text>
          </View>
        </View>
        <View style={styles.controls}>
          <Big icon="play-back" label="30 s back" onPress={() => void send('seekBy', -30)} />
          <Big icon="arrow-undo" label="10 s back" onPress={() => void send('seekBy', -10)} />
          <Big icon={paused ? 'play' : 'pause'} large label={paused ? 'Play' : 'Pause'} onPress={() => void send('toggle')} />
          <Big icon="arrow-redo" label="10 s ahead" onPress={() => void send('seekBy', 10)} />
          <Big icon="play-forward" label="30 s ahead" onPress={() => void send('seekBy', 30)} />
        </View>
        <View style={styles.actions}>
          <Button kind="secondary" icon="stop" label="Stop" onPress={() => void send('stop').then(onClose)} />
          {/* a YouTube video from a shared link plays on screens only */}
          {state.casted ? (
            <Button
              icon="phone-portrait-outline"
              label="Continue on phone"
              onPress={() => {
                onClose()
                void continueOnPhone()
              }}
            />
          ) : null}
        </View>
      </View>
    </Sheet>
  )
}

function Big({ icon, label, onPress, large }: { icon: IconName; label: string; onPress: () => void; large?: boolean }) {
  return (
    <Press onPress={onPress} hitSlop={6} accessibilityRole="button" accessibilityLabel={label} style={[styles.big, large && styles.bigLarge]}>
      <Ionicons name={icon} size={large ? 34 : 24} color={large ? color.onFocus : color.text} />
    </Press>
  )
}

const styles = StyleSheet.create({
  sheet: { paddingHorizontal: space.l, paddingBottom: space.l, gap: space.xs },
  heading: { marginBottom: space.s },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.m, paddingVertical: space.m, borderRadius: radius.l },
  rowChosen: { backgroundColor: color.surface1 },
  empty: { paddingVertical: space.m },
  again: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start', paddingVertical: space.s, marginTop: space.xs },
  castButton: { padding: space.xs },
  bar: {
    position: 'absolute',
    left: space.m,
    right: space.m,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingLeft: space.m,
    paddingRight: space.xs,
    paddingVertical: space.s,
    borderRadius: radius.l,
    backgroundColor: color.surface3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    overflow: 'hidden',
  },
  barMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.m },
  barButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  barProgress: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  time: { marginTop: space.l, gap: space.xs },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.l, paddingHorizontal: space.s },
  big: { width: 48, height: 48, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface1 },
  bigLarge: { width: 72, height: 72, backgroundColor: color.focus },
  actions: { flexDirection: 'row', gap: space.m, marginTop: space.xl },
})
