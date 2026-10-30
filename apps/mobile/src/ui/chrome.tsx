import { useState, type ReactNode } from 'react'
import { StyleSheet, Text, View, type LayoutRectangle } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Ionicons from '@expo/vector-icons/Ionicons'
import Animated, { Easing, interpolate, useAnimatedStyle, useReducedMotion, withTiming, type SharedValue } from 'react-native-reanimated'
import type { IconName } from './components'
import { Mark } from './brand'
import { Press } from './press'
import { color, font, space } from './theme'

// The app's chrome. The bottom navigation is the one everyone knows (an icon
// over a word per section), in the page's own black, with one detail of a
// cinema: an aisle light, a thin line of the mark's gold along the top edge of
// the section you are in, gliding to the next one when you change; its icon
// fills in gold. The top: the mark and the server the films come from, Search,
// the profile ringed in gold, on the page's darkness.

export type TabItem = { key: string; label: string; icon: [IconName, IconName] }

export const TAB_BAR_HEIGHT = 58

const LIGHT_WIDTH = 28
const EASE = Easing.bezier(0.2, 0.7, 0.2, 1)

/** The bottom navigation: `active` is the key in the light; `onSelect` is told the key tapped */
export function TabBar({ items, active, onSelect }: { items: TabItem[]; active: string; onSelect: (key: string) => void }) {
  const insets = useSafeAreaInsets()
  const reduced = useReducedMotion()
  const [frames, setFrames] = useState<Record<string, LayoutRectangle>>({})
  const frame = frames[active]

  const light = useAnimatedStyle(() => {
    if (!frame) return { opacity: 0 }
    const left = frame.x + frame.width / 2 - LIGHT_WIDTH / 2
    return reduced ? { opacity: 1, transform: [{ translateX: left }] } : { opacity: withTiming(1, { duration: 200 }), transform: [{ translateX: withTiming(left, { duration: 340, easing: EASE }) }] }
  }, [frame, reduced])

  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom }]}>
      <Animated.View style={[styles.light, light]} pointerEvents="none">
        <LinearGradient colors={[color.lightGlow, color.transparentGold]} style={styles.glow} />
      </Animated.View>
      {items.map((item) => {
        const on = item.key === active
        return (
          <Press
            key={item.key}
            scale={0.92}
            onPress={() => onSelect(item.key)}
            onLayout={(e) => {
              const layout = e.nativeEvent.layout
              setFrames((f) => (f[item.key]?.x === layout.x && f[item.key]?.width === layout.width ? f : { ...f, [item.key]: layout }))
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={item.label}
            style={styles.tab}
          >
            <Ionicons name={on ? item.icon[1] : item.icon[0]} size={22} color={on ? color.accent : color.textMuted} />
            <Text style={[styles.label, on && styles.labelOn]} numberOfLines={1}>
              {item.label}
            </Text>
          </Press>
        )
      })}
    </View>
  )
}

/**
 * The top of a section: the mark and where the films come from; Search and the
 * profile on the right. Over a picture it is clear; the page's black gathers
 * behind it as `scrollY` grows, never a bar.
 */
export function TopBar({
  server,
  profile,
  onProfile,
  onSearch,
  scrollY,
  solidAfter = 200,
  onBack,
}: {
  /** A screen opened over a section (a plugin's): Back before the mark */
  onBack?: () => void
  server: string
  profile: ReactNode
  onProfile: () => void
  onSearch: () => void
  scrollY: SharedValue<number>
  solidAfter?: number
}) {
  const insets = useSafeAreaInsets()
  // The mark and its words must read over the brightest poster: a dark band behind them always,
  // deepening to the page's black as the page scrolls under it
  const shade = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [0, solidAfter], [0.82, 1], 'clamp') }))
  return (
    <View style={[styles.top, { paddingTop: insets.top + space.xs }]} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, shade]} pointerEvents="none">
        <LinearGradient colors={[color.bg, color.dark86, color.dark75, color.transparent]} locations={[0, 0.45, 0.7, 1]} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <View style={styles.where} accessibilityRole="header" accessibilityLabel={`Playpex, showing from ${server}`}>
        {onBack ? (
          <Press onPress={onBack} hitSlop={10} scale={0.9} accessibilityLabel="Back" accessibilityRole="button" style={styles.back}>
            <Ionicons name="chevron-back" size={24} color={color.text} />
          </Press>
        ) : null}
        <Mark size={26} />
        <View>
          <Text style={styles.brand}>Playpex</Text>
          <Text style={styles.server} numberOfLines={1}>
            Showing from {server}
          </Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Press onPress={onSearch} hitSlop={10} scale={0.9} accessibilityLabel="Search" accessibilityRole="button" style={styles.search}>
          <Ionicons name="search" size={21} color={color.text} />
        </Press>
        <Press onPress={onProfile} hitSlop={10} scale={0.9} accessibilityLabel="Change profile" accessibilityRole="button" style={styles.ring}>
          {profile}
        </Press>
      </View>
    </View>
  )
}

export const TOP_BAR_HEIGHT = 64

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    // Solid: what scrolls under it never shows through the words
    backgroundColor: color.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  // The aisle light: a line of gold on the bar's top edge, its glow falling into the bar
  light: { position: 'absolute', top: -1, left: 0, width: LIGHT_WIDTH, alignItems: 'center' },
  glow: { width: LIGHT_WIDTH, height: 14, borderTopWidth: 2, borderTopColor: color.accent, borderRadius: 1 },
  tab: { flex: 1, height: TAB_BAR_HEIGHT, alignItems: 'center', justifyContent: 'center', gap: 3 },
  label: { fontFamily: font.medium, fontSize: 11, letterSpacing: 0.1, color: color.textMuted },
  labelOn: { color: color.text },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: space.l, paddingBottom: space.xxl, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  where: { flexDirection: 'row', alignItems: 'center', gap: space.s, flexShrink: 1 },
  // A shadow under the words too: what still shows through the band never meets their edges
  brand: { fontFamily: font.display, fontSize: 18, lineHeight: 20, color: color.text, letterSpacing: -0.2, textShadowColor: color.scrim, textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },
  server: { fontFamily: font.medium, fontSize: 12, lineHeight: 15, color: color.textSoft, maxWidth: 190, textShadowColor: color.scrim, textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  back: { marginLeft: -space.s, marginRight: -space.xxs, width: 36, height: 40, alignItems: 'center', justifyContent: 'center' },
  search: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: color.glass },
  ring: { padding: 2, borderRadius: 22, borderWidth: 1.5, borderColor: color.accent },
})
