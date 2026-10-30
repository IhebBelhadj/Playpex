import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { GestureDetector, usePanGesture, useTapGesture, useSimultaneousGestures } from 'react-native-gesture-handler'
import { formatTime } from '../../core/services/playback'
import { color, font, radius, space } from '../../ui/theme'

// The timeline, as on the TV: what has played (gold), what is ready around
// it (the player's memory, a torrent's downloaded pieces), the rest faint; the
// time now, a hint ("Ends at 22:41"), the time left. Dragging or tapping
// scrubs: a white tab says where it lands and how far that is from now
// (outlined when that part isn't downloaded yet: the jump waits for it); the
// seek happens on release (PlayerController.endScrub).

type Props = {
  position: number
  duration: number
  /** Seconds the player has in memory up to */
  bufferedTo: number
  /** A torrent's piece runs (percent, alternating downloaded / missing, starting with downloaded) */
  downloaded: number[] | null
  scrub: number | null
  /** Under the bar, between the times */
  hint: string
  onScrub: (seconds: number) => void
  onRelease: () => void
}

const TAB_WIDTH = 132

export function Timeline({ position, duration, bufferedTo, downloaded, scrub, hint, onScrub, onRelease }: Props) {
  const [width, setWidth] = useState(1)
  const at = (x: number) => Math.max(0, Math.min(1, x / width)) * duration
  const pan = usePanGesture({
    runOnJS: true,
    minDistance: 0,
    onActivate: (e) => onScrub(at(e.x)),
    onUpdate: (e) => onScrub(at(e.x)),
    onDeactivate: () => onRelease(),
  })
  const tap = useTapGesture({
    runOnJS: true,
    onActivate: (e) => {
      onScrub(at(e.x))
      onRelease()
    },
  })
  const gesture = useSimultaneousGestures(pan, tap)

  const ratio = (s: number) => (duration ? Math.min(1, Math.max(0, s / duration)) : 0)
  const played = ratio(position)
  const buffered = ratio(bufferedTo)
  const scrubbing = scrub != null
  const target = scrub ?? position
  const away = scrubbing && downloaded != null && !isDownloaded(downloaded, ratio(target) * 100) && !(target >= position && target <= bufferedTo)
  const delta = target - position

  return (
    <View>
      <GestureDetector gesture={gesture}>
        <View style={styles.hit} onLayout={(e) => setWidth(e.nativeEvent.layout.width || 1)} accessibilityRole="adjustable" accessibilityLabel="Timeline" accessibilityValue={{ text: `${formatTime(position)} of ${formatTime(duration)}` }}>
          <View style={[styles.track, scrubbing && styles.trackActive]} pointerEvents="none">
            {downloaded ? <Downloaded runs={downloaded} /> : null}
            <View style={[styles.buffered, { left: `${played * 100}%`, width: `${Math.max(0, buffered - played) * 100}%` }]} />
            <View style={[styles.played, { width: `${played * 100}%` }]} />
          </View>
          <View style={[styles.knob, scrubbing && styles.knobActive, { left: `${played * 100}%` }]} pointerEvents="none" />
          {scrubbing ? (
            <View style={[styles.mark, { left: ratio(target) * width }]} pointerEvents="none">
              <View style={styles.markLine} />
              <View style={[styles.tab, away && styles.tabAway, { left: Math.max(-ratio(target) * width, Math.min(width - ratio(target) * width - TAB_WIDTH, -TAB_WIDTH / 2)) }]}>
                <Text style={[styles.tabTime, away && styles.tabTimeAway]}>{formatTime(target)}</Text>
                <Text style={[styles.tabDelta, away && styles.tabDeltaAway]}>
                  {delta < 0 ? '−' : '+'}
                  {formatTime(Math.abs(delta))}
                </Text>
              </View>
            </View>
          ) : null}
        </View>
      </GestureDetector>
      <View style={styles.times}>
        <Text style={styles.now}>{formatTime(target)}</Text>
        <Text style={styles.hint} numberOfLines={1}>
          {scrubbing ? (away ? 'Not downloaded yet: it loads first' : 'Release to jump') : hint}
        </Text>
        <Text style={styles.left}>−{formatTime(Math.max(0, duration - target))}</Text>
      </View>
    </View>
  )
}

/** Whether `percent` of the file falls in a downloaded run */
function isDownloaded(runs: number[], percent: number): boolean {
  let at = 0
  for (let i = 0; i < runs.length; i++) {
    if (percent >= at && percent < at + runs[i]) return i % 2 === 0
    at += runs[i]
  }
  return percent >= 99.9
}

/** The downloaded stretches of a torrent's pieces */
function Downloaded({ runs }: { runs: number[] }) {
  const bands: { left: number; width: number }[] = []
  let at = 0
  runs.forEach((run, i) => {
    if (i % 2 === 0 && run > 0) bands.push({ left: at, width: run })
    at += run
  })
  return (
    <>
      {bands.map((b) => (
        <View key={b.left} style={[styles.downloaded, { left: `${b.left}%`, width: `${b.width}%` }]} />
      ))}
    </>
  )
}

const styles = StyleSheet.create({
  hit: { height: 32, justifyContent: 'center' },
  track: { height: 4, borderRadius: radius.pill, backgroundColor: color.progressTrack, overflow: 'hidden' },
  trackActive: { height: 8 },
  downloaded: { position: 'absolute', top: 0, bottom: 0, backgroundColor: color.downloaded },
  buffered: { position: 'absolute', top: 0, bottom: 0, backgroundColor: color.buffered },
  played: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: color.progress },
  knob: { position: 'absolute', width: 12, height: 12, borderRadius: 6, marginLeft: -6, backgroundColor: color.progress },
  knobActive: { width: 18, height: 18, borderRadius: 9, marginLeft: -9, backgroundColor: color.focus },
  mark: { position: 'absolute', top: 0, bottom: 0, width: 0 },
  markLine: { position: 'absolute', left: -1, top: 2, bottom: 2, width: 2, backgroundColor: color.focus },
  tab: {
    position: 'absolute',
    bottom: 34,
    width: TAB_WIDTH,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: space.s,
    paddingVertical: space.s,
    borderRadius: radius.m,
    backgroundColor: color.focus,
  },
  tabAway: { backgroundColor: color.raised, borderWidth: 2, borderColor: color.focus },
  tabTime: { fontFamily: font.display, fontSize: 16, color: color.onFocus, fontVariant: ['tabular-nums'] },
  tabTimeAway: { color: color.text },
  tabDelta: { fontFamily: font.medium, fontSize: 12, color: color.onFocusMuted, fontVariant: ['tabular-nums'] },
  tabDeltaAway: { color: color.textMuted },
  times: { flexDirection: 'row', alignItems: 'baseline', marginTop: space.xxs },
  now: { minWidth: 72, fontFamily: font.medium, fontSize: 14, color: color.textSoft, fontVariant: ['tabular-nums'] },
  hint: { flex: 1, textAlign: 'center', fontFamily: font.body, fontSize: 12, color: color.textMuted },
  left: { minWidth: 72, textAlign: 'right', fontFamily: font.medium, fontSize: 14, color: color.textSoft, fontVariant: ['tabular-nums'] },
})
