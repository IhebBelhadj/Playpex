import { useState } from 'react'
import { StyleSheet } from 'react-native'
import Animated, { Easing, Keyframe, ReduceMotion } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { useSessionState } from '../../state/app'
import { Mark } from '../../ui/brand'
import { color } from '../../ui/theme'

// The app's one orchestrated moment: over the first screen, the mark the native
// splash showed grows a little and fades as the dark lifts. It plays once, when
// the session knows where it is (the splash hides then: state/launch.ts).

/** The native splash's mark as Android 12+ draws it (measured on a phone: ~37 dp wide), so the hand-off doesn't jump */
const SPLASH_MARK = 37
const EASE = Easing.out(Easing.cubic)

const lift = new Keyframe({ 0: { opacity: 1 }, 30: { opacity: 1 }, 100: { opacity: 0, easing: EASE } }).duration(900).reduceMotion(ReduceMotion.System)
const grow = new Keyframe({
  0: { opacity: 1, transform: [{ scale: 1 }] },
  30: { opacity: 1, transform: [{ scale: 1 }] },
  100: { opacity: 0, transform: [{ scale: 1.6 }], easing: EASE },
})
  .duration(900)
  .reduceMotion(ReduceMotion.System)

export function LightsDown() {
  const state = useSessionState()
  const [done, setDone] = useState(false)
  if (done || state.kind === 'booting' || state.kind === 'reaching') return null
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.veil]}
      pointerEvents="none"
      entering={lift.withCallback((finished) => {
        'worklet'
        if (finished) scheduleOnRN(setDone, true)
      })}
    >
      <Animated.View style={styles.mark} entering={grow}>
        <Mark size={SPLASH_MARK} centred />
      </Animated.View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  // The final style of both keyframes: what stays when the animation has run
  veil: { backgroundColor: color.bg, alignItems: 'center', justifyContent: 'center', opacity: 0 },
  mark: { opacity: 0 },
})
