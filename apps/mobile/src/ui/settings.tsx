import { useState, type ReactNode } from 'react'
import { StyleSheet, Switch, Text, View } from 'react-native'
import Ionicons from '@expo/vector-icons/Ionicons'
import Animated, { FadeIn, FadeOut, LinearTransition, useReducedMotion } from 'react-native-reanimated'
import { Press } from './press'
import { color, font, motion, radius, space, text } from './theme'

// The Settings page's pieces. A group is a heading and its rows on one
// surface; a row says what it sets and its value on the right. A choice opens
// in place (the rows under it make room) instead of a dialog, so the list of
// options stays next to what it changes.

export function SettingsGroup({ title, why, children }: { title: string; why?: string; children: ReactNode }) {
  return (
    <Animated.View layout={LinearTransition.duration(motion.base)} style={styles.group}>
      <Text style={text.heading}>{title}</Text>
      {why ? <Text style={[text.small, styles.why]}>{why}</Text> : null}
      <View style={styles.surface}>{children}</View>
    </Animated.View>
  )
}

/** A fact (`value`), or a way somewhere (`onPress`) */
export function SettingRow({ label, value, onPress, first }: { label: string; value?: string; onPress?: () => void; first?: boolean }) {
  const body = (
    <>
      <Text style={styles.label}>{label}</Text>
      {value ? (
        <Text style={styles.value} numberOfLines={2}>
          {value}
        </Text>
      ) : null}
      {onPress ? <Ionicons name="chevron-forward" size={18} color={color.textDim} /> : null}
    </>
  )
  return onPress ? (
    <Press onPress={onPress} scale={0.99} style={[styles.row, !first && styles.divided]} accessibilityRole="button">
      {body}
    </Press>
  ) : (
    <View style={[styles.row, !first && styles.divided]} accessible accessibilityLabel={`${label}: ${value ?? ''}`}>
      {body}
    </View>
  )
}

export function ToggleRow({ label, detail, on, onChange, first }: { label: string; detail?: string; on: boolean; onChange: (on: boolean) => void; first?: boolean }) {
  return (
    <Press onPress={() => onChange(!on)} scale={1} style={[styles.row, !first && styles.divided]} accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={label}>
      <View style={{ flex: 1 }}>
        <Text style={styles.label}>{label}</Text>
        {detail ? <Text style={[text.tiny, { marginTop: 2 }]}>{detail}</Text> : null}
      </View>
      <Switch value={on} onValueChange={onChange} trackColor={{ false: color.surface4, true: color.accentDeep }} thumbColor={on ? color.accent : color.textMuted} />
    </Press>
  )
}

export type Choice<T extends string> = { value: T; label: string; detail?: string }

/** A row whose options open under it; choosing one closes them */
export function ChoiceRow<T extends string>({ label, value, choices, onChoose, first }: { label: string; value: T; choices: Choice<T>[]; onChoose: (value: T) => void; first?: boolean }) {
  const [open, setOpen] = useState(false)
  const reduced = useReducedMotion()
  const current = choices.find((c) => c.value === value)
  return (
    <Animated.View layout={reduced ? undefined : LinearTransition.duration(motion.base)} style={[!first && styles.divided, { overflow: 'hidden' }]}>
      <Press onPress={() => setOpen(!open)} scale={0.99} style={styles.row} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${label}: ${current?.label ?? value}`}>
        <Text style={styles.label}>{label}</Text>
        <Text style={[styles.value, open && { color: color.accent }]} numberOfLines={1}>
          {current?.label ?? value}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={open ? color.accent : color.textDim} />
      </Press>
      {open ? (
        <Animated.View entering={reduced ? undefined : FadeIn.duration(motion.base)} exiting={reduced ? undefined : FadeOut.duration(motion.fast)} style={styles.choices}>
          {choices.map((c) => {
            const on = c.value === value
            return (
              <Press
                key={c.value}
                onPress={() => {
                  setOpen(false)
                  if (!on) onChoose(c.value)
                }}
                scale={0.98}
                style={[styles.choice, on && styles.choiceOn]}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.choiceLabel, on && { color: color.accent }]}>{c.label}</Text>
                  {c.detail ? <Text style={text.tiny}>{c.detail}</Text> : null}
                </View>
                {on ? <Ionicons name="checkmark" size={20} color={color.accent} /> : null}
              </Press>
            )
          })}
        </Animated.View>
      ) : null}
    </Animated.View>
  )
}

/** A few values side by side, one lit */
export function Segmented<T extends string>({ choices, value, onChoose }: { choices: Choice<T>[]; value: T; onChoose: (value: T) => void }) {
  return (
    <View style={styles.segments} accessibilityRole="radiogroup">
      {choices.map((c) => {
        const on = c.value === value
        return (
          <Press key={c.value} onPress={() => onChoose(c.value)} scale={0.96} style={[styles.segment, on && styles.segmentOn]} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={c.detail ?? c.label}>
            <Text style={[styles.segmentLabel, on && { color: color.onAccent }]}>{c.label}</Text>
          </Press>
        )
      })}
    </View>
  )
}

/**
 * A still of a film with a line of subtitles at `scale`: what the size looks
 * like before playing anything (mpv draws them at about 5.5 % of the picture's
 * height at scale 1)
 */
export function SubtitlePreview({ scale }: { scale: number }) {
  const [height, setHeight] = useState(0)
  const size = Math.max(9, height * 0.055 * scale)
  return (
    <View style={styles.still} onLayout={(e) => setHeight(e.nativeEvent.layout.height)} accessible accessibilityLabel="Subtitle size preview">
      <View style={styles.horizon} />
      <Text style={[styles.subtitle, { fontSize: size, lineHeight: size * 1.25 }]}>We’re going to need a bigger boat.</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  group: { marginBottom: space.xxl, paddingHorizontal: space.l },
  why: { marginTop: space.xxs },
  surface: { marginTop: space.m, borderRadius: radius.l, backgroundColor: color.surface2, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 56, paddingHorizontal: space.l, paddingVertical: space.m },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
  label: { flex: 1, fontFamily: font.medium, fontSize: 16, lineHeight: 21, color: color.text, includeFontPadding: false },
  value: { fontFamily: font.medium, fontSize: 14, color: color.textMuted, maxWidth: '55%', textAlign: 'right', includeFontPadding: false },
  choices: { paddingHorizontal: space.s, paddingBottom: space.s, gap: space.xxs },
  choice: { flexDirection: 'row', alignItems: 'center', minHeight: 46, paddingHorizontal: space.m, borderRadius: radius.m },
  choiceOn: { backgroundColor: color.surface1 },
  choiceLabel: { fontFamily: font.medium, fontSize: 15, color: color.textSoft },
  segments: { flexDirection: 'row', gap: space.xs, padding: space.xs, margin: space.m, borderRadius: radius.pill, backgroundColor: color.surface1 },
  segment: { flex: 1, height: 38, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  segmentOn: { backgroundColor: color.accent },
  segmentLabel: { fontFamily: font.semibold, fontSize: 14, color: color.textSoft },
  still: { aspectRatio: 16 / 9, margin: space.m, marginBottom: 0, borderRadius: radius.m, overflow: 'hidden', backgroundColor: color.stillSky, justifyContent: 'flex-end', alignItems: 'center' },
  horizon: { position: 'absolute', left: 0, right: 0, bottom: 0, top: '58%', backgroundColor: color.stillSea },
  subtitle: {
    marginBottom: '6%',
    paddingHorizontal: space.m,
    textAlign: 'center',
    color: color.subtitle,
    fontFamily: font.semibold,
    textShadowColor: color.black,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
})
