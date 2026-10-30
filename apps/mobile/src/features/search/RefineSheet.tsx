import type { ReactNode } from 'react'
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native'
import { CODECS, NO_REFINE, QUALITIES, SIZES, SORTS, WHATS, facets, refine, toggle, type Refine } from '../../core/search/refine'
import type { Found } from '../../core/services/releases'
import { Button } from '../../ui/components'
import { Chip } from '../../ui/section'
import { Sheet } from '../../ui/sheet'
import { color, space, text } from '../../ui/theme'

// Search's panel for videos or torrents: the order, then filters by quality,
// what it is, size, video codec, where it came from and names holding every
// word. Everything is already on the phone, so a change shows at once; each
// option says how many results it leaves (the other filters on), and only
// options some result has are offered.

type Props = {
  noun: string
  items: Found[]
  value: Refine
  /** Provider ids → names */
  sources: Map<string, string>
  onChange: (value: Refine) => void
  onClose: () => void
}

export function RefineSheet({ noun, items, value, sources, onChange, onClose }: Props) {
  const f = facets(items, value)
  const left = refine(items, value).length
  // In a modal: Search sits in the tabs, and the tab bar would cover the panel's foot
  return (
    <Modal visible transparent statusBarTranslucent navigationBarTranslucent animationType="none" onRequestClose={onClose}>
      <Sheet
        label={`Sort and filter ${noun}`}
        onClose={onClose}
        footer={
          <>
            <Button kind="quiet" label="Clear" onPress={() => onChange({ ...NO_REFINE, sort: value.sort })} />
            <Button label={left ? `Show ${left.toLocaleString()} ${noun}` : `No ${noun} like that`} onPress={onClose} style={{ flex: 1 }} />
          </>
        }
      >
        <ScrollView contentContainerStyle={styles.content}>
          <Section title="Order">
            {SORTS.filter((s) => noun !== 'videos' || s.value !== 'seeds').map((s) => (
              <Chip key={s.value} label={s.label} on={value.sort === s.value} onPress={() => onChange({ ...value, sort: s.value })} />
            ))}
          </Section>

          <Section title="Name" why="Sites answer loosely: keep the ones whose name holds every word you typed">
            <Chip label={`Every word in the name  ${f.exact}`} on={value.exact} onPress={() => onChange({ ...value, exact: !value.exact })} />
          </Section>

          <Group title="Quality" options={QUALITIES} counts={f.qualities} on={value.qualities} onToggle={(v) => onChange({ ...value, qualities: toggle(value.qualities, v) })} />
          <Group title="What it is" options={WHATS} counts={f.what} on={value.what} onToggle={(v) => onChange({ ...value, what: toggle(value.what, v) })} />
          <Group title="Size" options={SIZES} counts={f.sizes} on={value.sizes} onToggle={(v) => onChange({ ...value, sizes: toggle(value.sizes, v) })} />
          <Group
            title="Video"
            why="HEVC and AV1 files are smaller; every one plays on this phone"
            options={CODECS}
            counts={f.codecs}
            on={value.codecs}
            onToggle={(v) => onChange({ ...value, codecs: toggle(value.codecs, v) })}
          />
          <Group
            title="From"
            options={[...sources].map(([id, name]) => ({ value: id, label: name }))}
            counts={f.sources}
            on={value.sources}
            onToggle={(v) => onChange({ ...value, sources: toggle(value.sources, v) })}
          />
        </ScrollView>
      </Sheet>
    </Modal>
  )
}

/** A filter group: each option that some result has, with how many it leaves; any number on at once */
function Group<K extends string>({
  title,
  why,
  options,
  counts,
  on,
  onToggle,
}: {
  title: string
  why?: string
  options: { value: K; label: string }[]
  counts: Map<K, number>
  on: K[]
  onToggle: (value: K) => void
}) {
  const offered = options.filter((o) => (counts.get(o.value) ?? 0) > 0 || on.includes(o.value))
  if (offered.length < 2 && !on.length) return null
  return (
    <Section title={title} why={why}>
      {offered.map((o) => (
        <Chip key={o.value} label={`${o.label}  ${counts.get(o.value) ?? 0}`} on={on.includes(o.value)} onPress={() => onToggle(o.value)} />
      ))}
    </Section>
  )
}

function Section({ title, why, children }: { title: string; why?: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={text.heading}>{title}</Text>
      {why ? <Text style={[text.tiny, { marginTop: space.xxs }]}>{why}</Text> : null}
      <View style={styles.wrap}>{children}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.l, paddingBottom: space.l },
  section: { paddingVertical: space.l, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s, marginTop: space.m },
})
