import type { ReactNode } from 'react'
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Ionicons from '@expo/vector-icons/Ionicons'
import Animated, { FadeIn, FadeOut, SlideInRight, SlideOutRight, useReducedMotion } from 'react-native-reanimated'
import { useBackPress } from '../../state/hooks'
import { Press } from '../../ui/press'
import { color, font, motion, radius, space, text } from '../../ui/theme'

// The player's panels, as the TV draws them: a pane docked at the right edge
// over the dimmed picture (the video keeps playing), its title on top, tabs
// when it has several parts. Tapping outside or Back closes it.

export function Panel({ title, onClose, children, width = 440 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  const insets = useSafeAreaInsets()
  const window = useWindowDimensions()
  const reduced = useReducedMotion()
  useBackPress(true, onClose)
  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <Animated.View entering={FadeIn.duration(motion.base)} exiting={FadeOut.duration(motion.fast)} style={[StyleSheet.absoluteFill, styles.dim]}>
        <Press onPress={onClose} scale={1} style={StyleSheet.absoluteFill} accessibilityLabel="Close" accessibilityRole="button" />
      </Animated.View>
      <Animated.View
        entering={reduced ? FadeIn : SlideInRight.duration(motion.base)}
        exiting={reduced ? FadeOut : SlideOutRight.duration(motion.fast)}
        style={[styles.pane, { width: Math.min(width, window.width * 0.62), paddingTop: insets.top + space.l, paddingRight: insets.right + space.xl, paddingBottom: insets.bottom }]}
        accessibilityLabel={title}
      >
        <View style={styles.head}>
          <Text style={text.heading}>{title}</Text>
          <Press onPress={onClose} hitSlop={12} accessibilityLabel="Close" accessibilityRole="button">
            <Ionicons name="close" size={24} color={color.textSecondary} />
          </Press>
        </View>
        {children}
      </Animated.View>
    </View>
  )
}

/** The panel's parts: the shown one is white with a line under it */
export function Tabs<K extends string>({ tabs, active, onChange }: { tabs: { key: K; label: string }[]; active: K; onChange: (key: K) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabs}>
      {tabs.map((t) => (
        <Press key={t.key} onPress={() => onChange(t.key)} accessibilityRole="tab" accessibilityState={{ selected: t.key === active }} style={styles.tab}>
          <Text style={[styles.tabLabel, t.key === active && styles.tabLabelActive]}>{t.label}</Text>
          <View style={[styles.tabLine, t.key === active && styles.tabLineActive]} />
        </Press>
      ))}
    </ScrollView>
  )
}

export function PanelScroll({ children }: { children: ReactNode }) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      {children}
    </ScrollView>
  )
}

/** A row to choose: the chosen one carries the gold mark, as on the TV */
export function Choice({ label, detail, chosen, onPress, disabled }: { label: string; detail?: string | null; chosen?: boolean; onPress?: () => void; disabled?: boolean }) {
  return (
    <Press
      onPress={onPress}
      disabled={disabled || !onPress}
      scale={0.98}
      style={[styles.choice, chosen && styles.choiceChosen, disabled && { opacity: 0.45 }]}
      accessibilityRole="radio"
      accessibilityState={{ selected: !!chosen, disabled: !!disabled }}
    >
      <View style={[styles.mark, chosen && styles.markOn]} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.choiceLabel, chosen && styles.choiceLabelChosen]} numberOfLines={2}>
          {label}
        </Text>
        {detail ? (
          <Text style={styles.choiceDetail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
    </Press>
  )
}

export function Section({ title, children, help }: { title?: string; children: ReactNode; help?: string | null }) {
  return (
    <View style={styles.section}>
      {title ? <Text style={styles.sectionTitle}>{title}</Text> : null}
      {children}
      {help ? <Text style={styles.help}>{help}</Text> : null}
    </View>
  )
}

export function Chips({ children }: { children: ReactNode }) {
  return <View style={styles.chips}>{children}</View>
}

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  return (
    <Press onPress={onPress} style={[styles.chip, selected && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: !!selected }}>
      <Text style={[styles.chipLabel, selected && styles.chipLabelOn]}>{label}</Text>
    </Press>
  )
}

/** A value moved in steps, with its origin to come back to */
export function Stepper({
  label,
  value,
  format,
  onChange,
  step,
  min,
  max,
  origin,
}: {
  label: string
  value: number
  format: (v: number) => string
  onChange: (v: number) => void
  step: number
  min: number
  max: number
  origin?: number
}) {
  const set = (v: number) => onChange(Math.round(Math.max(min, Math.min(max, v)) * 100) / 100)
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperControls}>
        <StepButton icon="remove" label={`${label}: less`} disabled={value <= min} onPress={() => set(value - step)} />
        <Press onPress={origin != null ? () => set(origin) : undefined} disabled={origin == null || value === origin} scale={1} accessibilityLabel={`${label}: reset`}>
          <Text style={[styles.stepperValue, origin != null && value !== origin && { color: color.accent }]}>{format(value)}</Text>
        </Press>
        <StepButton icon="add" label={`${label}: more`} disabled={value >= max} onPress={() => set(value + step)} />
      </View>
    </View>
  )
}

function StepButton({ icon, label, onPress, disabled }: { icon: 'add' | 'remove'; label: string; onPress: () => void; disabled: boolean }) {
  return (
    <Press onPress={onPress} disabled={disabled} hitSlop={8} accessibilityLabel={label} accessibilityRole="button" style={[styles.stepButton, disabled && { opacity: 0.35 }]}>
      <Ionicons name={icon} size={20} color={color.text} />
    </Press>
  )
}

export function Note({ children }: { children: ReactNode }) {
  return <Text style={styles.note}>{children}</Text>
}

/** Stats as the TV lists them: name, value */
export function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <View style={styles.facts}>
      {rows.map(([name, value]) => (
        <View key={name} style={styles.fact}>
          <Text style={styles.factName}>{name}</Text>
          <Text style={styles.factValue}>{value}</Text>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  dim: { backgroundColor: color.scrim },
  pane: { position: 'absolute', top: 0, right: 0, bottom: 0, paddingLeft: space.xl, backgroundColor: color.raised, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: color.lineStrong },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.m },
  tabsScroll: { flexGrow: 0, marginBottom: space.m },
  tabs: { gap: space.l },
  tab: { paddingTop: space.xs },
  tabLabel: { fontFamily: font.medium, fontSize: 15, color: color.textMuted },
  tabLabelActive: { color: color.text, fontFamily: font.semibold },
  tabLine: { height: 2, marginTop: space.xs, borderRadius: 1, backgroundColor: color.transparent },
  tabLineActive: { backgroundColor: color.text },
  scroll: { paddingBottom: space.xl, gap: space.l },
  section: { gap: space.s },
  sectionTitle: { fontFamily: font.semibold, fontSize: 14, color: color.textSecondary },
  help: { ...text.tiny, color: color.textMuted },
  choice: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.s + 2, paddingHorizontal: space.m, borderRadius: radius.m },
  choiceChosen: { backgroundColor: color.surface1 },
  mark: { width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: color.transparent },
  markOn: { backgroundColor: color.accent },
  choiceLabel: { fontFamily: font.medium, fontSize: 15, lineHeight: 20, color: color.textSoft },
  choiceLabelChosen: { color: color.text, fontFamily: font.semibold },
  choiceDetail: { ...text.tiny, color: color.textMuted, marginTop: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  chip: { paddingHorizontal: space.m + 2, paddingVertical: space.s, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong, backgroundColor: color.surface1 },
  chipOn: { backgroundColor: color.text, borderColor: color.text },
  chipLabel: { fontFamily: font.medium, fontSize: 14, color: color.textSoft },
  chipLabelOn: { color: color.onFocus, fontFamily: font.semibold },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m },
  stepperLabel: { fontFamily: font.semibold, fontSize: 14, color: color.textSecondary },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  stepButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface1, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  stepperValue: { minWidth: 76, textAlign: 'center', fontFamily: font.semibold, fontSize: 15, color: color.text, fontVariant: ['tabular-nums'] },
  note: { ...text.small, paddingHorizontal: space.m, paddingVertical: space.s },
  facts: { gap: space.xs + 2 },
  fact: { flexDirection: 'row', gap: space.m },
  factName: { width: 128, fontFamily: font.medium, fontSize: 13, color: color.textMuted },
  factValue: { flex: 1, fontFamily: font.medium, fontSize: 13, color: color.text, fontVariant: ['tabular-nums'] },
})
