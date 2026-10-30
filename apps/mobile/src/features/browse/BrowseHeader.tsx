import { ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Ionicons from '@expo/vector-icons/Ionicons'
import Animated, { interpolate, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated'
import type { Phrase, Token } from '../../core/catalog/browse'
import { IconButton } from '../../ui/components'
import { Press } from '../../ui/press'
import { color, font, radius, space, text } from '../../ui/theme'

// See all's header: one piece holding the way back, what the page shows and
// its filters. Open, the title is large and plain, the count under it, and the
// filters on as chips (tap one to remove it); Filters opens the panel. As the
// grid scrolls the header gives its room to the posters: the title shrinks up
// into the bar beside Back, the Filters button folds to its icon and count.

export type Part = NonNullable<Phrase['part']>

/** The bar the header folds into, under the status bar */
export const BAR = 56
const BACK = 40 + space.m
/** Where the sentence's first line lands in the bar, and how small it gets there */
const LAND_SCALE = 0.54

type Props = {
  title: string
  count: string
  tokens: Token[]
  filters: number
  scrollY: SharedValue<number>
  /** The body under the bar (sentence, count, filters on): how much the header can fold */
  body: number
  onBody: (height: number) => void
  onFilters: () => void
  onRemove: (token: Token) => void
  onClear: () => void
}

export function BrowseHeader({ title, count, tokens, filters, scrollY, body, onBody, onFilters, onRemove, onClear }: Props) {
  const insets = useSafeAreaInsets()
  const label = useSharedValue(0)
  const fold = Math.max(1, body)

  const frame = useAnimatedStyle(() => ({ height: insets.top + BAR + body - Math.min(Math.max(scrollY.value, 0), body) }))
  const edge = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [fold * 0.8, fold], [0, 1], 'clamp') }))
  const sentence = useAnimatedStyle(() => {
    const t = interpolate(scrollY.value, [0, fold], [0, 1], 'clamp')
    return {
      opacity: interpolate(t, [0.4, 0.68], [1, 0], 'clamp'),
      transform: [
        { translateX: interpolate(t, [0, 1], [0, BACK]) },
        // From under the bar to the bar's middle line
        { translateY: interpolate(t, [0, 1], [0, -BAR + (BAR - 38 * LAND_SCALE) / 2 - space.xxs]) },
        { scale: interpolate(t, [0, 1], [1, LAND_SCALE]) },
      ],
    }
  })
  const meta = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [0, fold * 0.45], [1, 0], 'clamp'),
    transform: [{ translateY: -Math.min(Math.max(scrollY.value, 0), fold) * 0.4 }],
  }))
  const line = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [fold * 0.72, fold], [0, 1], 'clamp') }))
  const word = useAnimatedStyle(() => {
    const opacity = interpolate(scrollY.value, [fold * 0.3, fold * 0.7], [1, 0], 'clamp')
    // Its natural width until measured, then folded to nothing
    if (label.value === 0) return { opacity }
    return { opacity, width: interpolate(scrollY.value, [fold * 0.4, fold], [label.value, 0], 'clamp') }
  })

  return (
    <Animated.View style={[styles.frame, frame]} pointerEvents="box-none">
      <View style={[styles.bar, { marginTop: insets.top }]} pointerEvents="box-none">
        <IconButton icon="chevron-back" label="Back" glass onPress={() => router.back()} />
        <Animated.Text style={[styles.line, line]} numberOfLines={1} importantForAccessibility="no">
          {title}
        </Animated.Text>
        <Press onPress={onFilters} scale={0.94} style={[styles.filters, filters > 0 && styles.filtersOn]} accessibilityRole="button" accessibilityLabel={filters ? `Filters, ${filters} on` : 'Filters'}>
          <Ionicons name="options-outline" size={18} color={filters ? color.accent : color.text} />
          <Animated.View style={[styles.wordBox, word]}>
            <Text
              style={styles.filtersLabel}
              numberOfLines={1}
              onLayout={(e) => {
                if (label.get() === 0) label.set(e.nativeEvent.layout.width + space.xxs)
              }}
            >
              Filters
            </Text>
          </Animated.View>
          {filters ? (
            <View style={styles.badge}>
              <Text style={styles.badgeLabel}>{filters}</Text>
            </View>
          ) : null}
        </Press>
      </View>

      <View style={styles.body} onLayout={(e: LayoutChangeEvent) => onBody(Math.round(e.nativeEvent.layout.height))} pointerEvents="box-none">
        <Animated.Text style={[styles.sentence, sentence]} accessibilityRole="header" numberOfLines={2}>
          {title}
        </Animated.Text>
        <Animated.View style={meta} pointerEvents="box-none">
          <Text style={[text.small, styles.count]}>{count}</Text>
          {tokens.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tokens} style={styles.tokensRow}>
              {tokens.map((t) => (
                <Press key={t.key} onPress={() => onRemove(t)} scale={0.95} style={styles.token} accessibilityRole="button" accessibilityLabel={`Remove ${t.label}`}>
                  <Text style={styles.tokenLabel}>{t.label}</Text>
                  <Ionicons name="close" size={15} color={color.accent} />
                </Press>
              ))}
              {tokens.length > 1 ? (
                <Press onPress={onClear} scale={0.95} style={styles.clear} accessibilityRole="button">
                  <Text style={[text.small, { color: color.textSoft }]}>Clear all</Text>
                </Press>
              ) : null}
            </ScrollView>
          ) : null}
        </Animated.View>
      </View>

      <Animated.View style={[styles.edge, edge]} pointerEvents="none" />
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  frame: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden', backgroundColor: color.bg },
  bar: { height: BAR, flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.l },
  line: { flex: 1, fontFamily: font.display, fontSize: 17, lineHeight: 21, color: color.text, includeFontPadding: false },
  filters: { flexDirection: 'row', alignItems: 'center', height: 40, paddingHorizontal: space.m, gap: space.xs, borderRadius: radius.pill, backgroundColor: color.surface1, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  filtersOn: { borderColor: color.accentDeep },
  wordBox: { overflow: 'hidden' },
  filtersLabel: { fontFamily: font.semibold, fontSize: 14, color: color.text, paddingLeft: space.xxs },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: color.accent },
  badgeLabel: { fontFamily: font.semibold, fontSize: 12, lineHeight: 14, color: color.onAccent, includeFontPadding: false },
  body: { paddingHorizontal: space.l, paddingTop: space.xs, paddingBottom: space.l },
  sentence: { fontFamily: font.display, fontSize: 32, lineHeight: 38, letterSpacing: -0.5, color: color.text, transformOrigin: 'left top' },
  count: { marginTop: space.s },
  tokensRow: { marginTop: space.m, marginHorizontal: -space.l },
  tokens: { gap: space.s, paddingHorizontal: space.l },
  token: { flexDirection: 'row', alignItems: 'center', gap: space.xs, height: 34, paddingLeft: space.m, paddingRight: space.s, borderRadius: radius.pill, borderWidth: 1, borderColor: color.accentDeep, backgroundColor: color.surface1 },
  tokenLabel: { fontFamily: font.semibold, fontSize: 14, color: color.accent },
  clear: { height: 34, justifyContent: 'center', paddingHorizontal: space.s },
  edge: { position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: color.line },
})
