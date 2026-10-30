import type { ReactNode } from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'
import Animated, { Easing, FadeIn, FadeOut, SlideInDown, SlideOutDown, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { Press } from './press'
import { color, motion, radius, space } from './theme'

// A panel that rises from the bottom over the page, which dims behind it: the
// page stays where it was, the panel works on it. Dragged down by its handle
// or tapped outside, it goes. The screen renders it only while open (its
// entering and exiting animations play), and closes it on Android's Back
// (state/hooks useBackPress).

const EASE = Easing.bezier(0.2, 0.7, 0.2, 1)

export function Sheet({ onClose, children, footer, label }: { onClose: () => void; children: ReactNode; footer?: ReactNode; label: string }) {
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const reduced = useReducedMotion()
  const drag = useSharedValue(0)
  const pan = usePanGesture({
    onUpdate: (e) => {
      'worklet'
      drag.value = Math.max(0, e.translationY)
    },
    onDeactivate: (e) => {
      'worklet'
      if (e.translationY > 120 || e.velocityY > 900) scheduleOnRN(onClose)
      else drag.value = withTiming(0, { duration: motion.fast })
    },
  })
  const dragged = useAnimatedStyle(() => ({ transform: [{ translateY: drag.value }] }))

  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <Animated.View entering={FadeIn.duration(motion.base)} exiting={FadeOut.duration(motion.fast)} style={[StyleSheet.absoluteFill, styles.dim]}>
        <Press onPress={onClose} scale={1} style={StyleSheet.absoluteFill} accessibilityLabel="Close" accessibilityRole="button" />
      </Animated.View>
      <Animated.View
        entering={reduced ? FadeIn : SlideInDown.duration(motion.slow).easing(EASE)}
        exiting={reduced ? FadeOut : SlideOutDown.duration(motion.base)}
        style={[styles.panel, { maxHeight: height * 0.86, paddingBottom: insets.bottom }, dragged]}
        accessibilityLabel={label}
      >
        <GestureDetector gesture={pan}>
          <View style={styles.handleArea}>
            <View style={styles.handle} />
          </View>
        </GestureDetector>
        <View style={{ flexShrink: 1 }}>{children}</View>
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  dim: { backgroundColor: color.scrim },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.surface2,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
  },
  handleArea: { alignItems: 'center', paddingTop: space.s, paddingBottom: space.m },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: color.lineStrong },
  footer: { flexDirection: 'row', gap: space.m, paddingHorizontal: space.l, paddingTop: space.m, paddingBottom: space.m, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
})
