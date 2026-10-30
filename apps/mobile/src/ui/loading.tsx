import { StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { Image } from 'expo-image'
import { LinearGradient } from 'expo-linear-gradient'
import Animated, { useReducedMotion } from 'react-native-reanimated'
import { Mark } from './brand'
import { color, radius, space, text } from './theme'

// Waiting, the cinema way. Loading is the countdown leader a projector shows
// before a film: a ring, its crosshairs and a hand of light sweeping round, the
// mark at its centre. A placeholder row is the shape of what is coming, and one
// band of the projector's light passes over it, each row a beat after the one
// above. Both hold still with reduced motion. (Reanimated CSS animations: no
// effect, no timer of ours.)

const HAND = require('../../assets/brand/leader-hand.svg')

export function Leader({ size = 64, label }: { size?: number; label?: string }) {
  const reduced = useReducedMotion()
  return (
    <View style={styles.center} accessibilityRole="progressbar" accessibilityLabel={label ?? 'Loading'}>
      <View style={[styles.leader, { width: size, height: size, borderRadius: size / 2 }]}>
        <View style={[styles.cross, { width: size - 2, height: StyleSheet.hairlineWidth }]} />
        <View style={[styles.cross, { height: size - 2, width: StyleSheet.hairlineWidth }]} />
        <Animated.View style={[StyleSheet.absoluteFill, !reduced && styles.sweep]}>
          <Image source={HAND} style={StyleSheet.absoluteFill} contentFit="contain" />
        </Animated.View>
        <Mark size={size * 0.34} centred />
      </View>
      {label ? <Text style={[text.small, styles.label]}>{label}</Text> : null}
    </View>
  )
}

/** The shapes of a row to come (posters, stills), with the light passing over them */
export function SkeletonRow({ width, ratio, count = 4, index = 0 }: { width: number; ratio: number; count?: number; index?: number }) {
  const reduced = useReducedMotion()
  const screen = useWindowDimensions().width
  return (
    <View style={styles.row}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.tile, { width, height: width * ratio }]} />
      ))}
      {!reduced ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.band,
            {
              animationName: { from: { transform: [{ translateX: -BAND }] }, to: { transform: [{ translateX: screen + BAND }] } },
              animationDelay: `${index * 180}ms`,
            },
          ]}
        >
          <LinearGradient colors={[color.transparentGold, color.lightGlow, color.transparentGold]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      ) : null}
    </View>
  )
}

/** A heading's shape and a row under it: what a section of a page looks like before it arrives */
export function SkeletonSection({ width, ratio, index = 0 }: { width: number; ratio: number; index?: number }) {
  return (
    <View style={styles.section}>
      <View style={styles.heading} />
      <SkeletonRow width={width} ratio={ratio} index={index} />
    </View>
  )
}

const BAND = 180

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl },
  leader: { alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2, borderColor: color.lineStrong, overflow: 'hidden' },
  cross: { position: 'absolute', backgroundColor: color.line },
  sweep: { animationName: { from: { transform: [{ rotate: '0deg' }] }, to: { transform: [{ rotate: '360deg' }] } }, animationDuration: '1400ms', animationIterationCount: 'infinite', animationTimingFunction: 'linear' },
  label: { marginTop: space.l, textAlign: 'center' },
  row: { flexDirection: 'row', gap: space.s + 2, paddingHorizontal: space.l, overflow: 'hidden' },
  tile: { borderRadius: radius.m, backgroundColor: color.surface2 },
  band: { position: 'absolute', top: 0, bottom: 0, left: 0, width: BAND, animationDuration: '1600ms', animationIterationCount: 'infinite', animationTimingFunction: 'ease-in-out' },
  section: { marginBottom: space.xxl },
  heading: { width: 150, height: 18, borderRadius: radius.s, backgroundColor: color.surface2, marginLeft: space.l, marginBottom: space.m },
})
