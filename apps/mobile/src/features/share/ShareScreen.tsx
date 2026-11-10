import { useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { Image } from 'expo-image'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Ionicons from '@expo/vector-icons/Ionicons'
import type { CastScreen } from '../../core/cast/caster'
import type { LinkItem } from '../../core/services/search'
import { itemLine, playsHere } from '../../core/services/share'
import { useCast } from '../../state/cast'
import { usePlayShared, useSharedLink } from '../../state/share'
import { Button, IconButton, Loading, Message, type IconName } from '../../ui/components'
import { Press } from '../../ui/press'
import { useToast } from '../../ui/toast'
import { color, radius, space, text } from '../../ui/theme'

// Share to Playpex (docs/cast-plan.md §5): a link another app shared, read by
// the server: what it found (a YouTube video, a video file, a stream, a
// torrent; a page's links), where to play it (the screens, this phone unless
// only a screen plays it), Play. Nothing found: Playpex can't play this link.

type Where = { deviceId: string; name: string } | 'phone'

function itemIcon(item: LinkItem): IconName {
  return item.kind === 'youtube' ? 'logo-youtube' : item.kind === 'magnet' || item.kind === 'torrent' ? 'magnet-outline' : item.kind === 'hls' ? 'radio-outline' : 'film-outline'
}

function screenIcon(kind: CastScreen['kind']): IconName {
  return kind === 'mobile' ? 'phone-portrait-outline' : kind === 'web' ? 'laptop-outline' : 'tv-outline'
}

export default function ShareScreen() {
  const { link } = useLocalSearchParams<{ link: string }>()
  const insets = useSafeAreaInsets()
  const found = useSharedLink(link)
  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.heading}>
        <View style={{ flex: 1 }}>
          <Text style={text.title}>Play a link</Text>
          <Text style={text.small} numberOfLines={1}>
            {link}
          </Text>
        </View>
        <IconButton icon="chevron-down" label="Close" glass onPress={() => router.back()} />
      </View>
      {found.isLoading ? (
        <Loading label="Reading the link…" />
      ) : found.error ? (
        <Message icon="alert-circle-outline" title="Playpex can’t read this link" body={found.error.message} action={{ label: 'Close', onPress: () => router.back() }} />
      ) : !found.data?.items.length ? (
        <Message icon="link-outline" title="Playpex can’t play this link" body="It isn’t a video, a stream, a torrent or a YouTube video, and it links to none." action={{ label: 'Close', onPress: () => router.back() }} />
      ) : (
        <Choose items={found.data.items} title={found.data.title ?? null} bottom={insets.bottom} />
      )}
    </View>
  )
}

function Choose({ items, title, bottom }: { items: LinkItem[]; title: string | null; bottom: number }) {
  const { state } = useCast()
  const play = usePlayShared()
  const toast = useToast()
  const [picked, setPicked] = useState(0)
  const item = items[Math.min(picked, items.length - 1)]
  const here = playsHere(item)
  // the screen Play sends to when one is chosen and on, else the first screen, else this phone
  const target = state.target && state.screens.some((s) => s.deviceId === state.target!.deviceId) ? state.target : null
  const [where, setWhere] = useState<Where | null>(null)
  const chosen: Where | null = where === 'phone' && !here ? null : (where ?? target ?? (state.screens[0] ? state.screens[0] : here ? 'phone' : null))
  const [busy, setBusy] = useState(false)

  const go = async () => {
    if (!chosen || busy) return
    setBusy(true)
    try {
      await play(item, chosen === 'phone' ? null : chosen)
      if (chosen !== 'phone') {
        toast(`Playing on ${chosen.name}`, { source: item.label })
        router.back()
      }
    } catch (e) {
      toast((e as Error).message || 'Couldn’t play it', { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.body}>
        {title && items.length > 1 ? <Text style={[text.label, styles.section]}>{title}</Text> : null}
        <Text style={[text.small, styles.section]}>{items.length > 1 ? `${items.length} things in this link` : 'Found'}</Text>
        {items.map((it, i) => (
          <Press key={`${it.kind}:${it.url}:${i}`} onPress={() => setPicked(i)} accessibilityRole="button" accessibilityState={{ selected: i === picked }} accessibilityLabel={it.label} style={[styles.row, i === picked && styles.rowChosen]}>
            {it.image ? <Image source={{ uri: it.image }} style={styles.thumb} contentFit="cover" /> : <Ionicons name={itemIcon(it)} size={24} color={i === picked ? color.accent : color.textMuted} />}
            <View style={{ flex: 1 }}>
              <Text style={text.label} numberOfLines={2}>
                {it.label}
              </Text>
              <Text style={text.small} numberOfLines={1}>
                {itemLine(it)}
              </Text>
            </View>
            {i === picked ? <Ionicons name="checkmark" size={20} color={color.accent} /> : null}
          </Press>
        ))}

        <Text style={[text.small, styles.section, { marginTop: space.l }]}>Play on</Text>
        {state.screens.map((s) => {
          const on = chosen !== 'phone' && chosen?.deviceId === s.deviceId
          const takes = item.kind === 'youtube' ? s.accepts.embed : item.kind === 'magnet' || item.kind === 'torrent' ? s.accepts.magnet : s.accepts.media
          return (
            <Press key={s.deviceId} disabled={!takes} onPress={() => setWhere({ deviceId: s.deviceId, name: s.name })} accessibilityRole="button" accessibilityState={{ selected: on, disabled: !takes }} accessibilityLabel={s.name} style={[styles.row, on && styles.rowChosen, !takes && { opacity: 0.45 }]}>
              <Ionicons name={screenIcon(s.kind)} size={24} color={on ? color.accent : color.textMuted} />
              <View style={{ flex: 1 }}>
                <Text style={text.label}>{s.name}</Text>
                <Text style={text.small}>{!takes ? 'Doesn’t play this' : s.playing ? `Playing ${s.playing.title ?? ''}`.trim() : 'Nothing playing'}</Text>
              </View>
              {on ? <Ionicons name="checkmark" size={20} color={color.accent} /> : null}
            </Press>
          )
        })}
        {here ? (
          <Press onPress={() => setWhere('phone')} accessibilityRole="button" accessibilityState={{ selected: chosen === 'phone' }} accessibilityLabel="This phone" style={[styles.row, chosen === 'phone' && styles.rowChosen]}>
            <Ionicons name="phone-portrait-outline" size={24} color={chosen === 'phone' ? color.accent : color.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={text.label}>This phone</Text>
            </View>
            {chosen === 'phone' ? <Ionicons name="checkmark" size={20} color={color.accent} /> : null}
          </Press>
        ) : null}
        {!state.screens.length ? (
          <Text style={[text.small, styles.note]}>{here ? 'No screen is on: it can play on this phone.' : 'No screen is on. Open Playpex TV on a screen to play it there.'}</Text>
        ) : null}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: bottom + space.m }]}>
        <Button label={busy ? 'Starting…' : chosen && chosen !== 'phone' ? `Play on ${chosen.name}` : 'Play'} icon="play" disabled={!chosen || busy} onPress={() => void go()} style={{ flex: 1 }} />
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.surface2 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: space.m, padding: space.l, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
  body: { padding: space.l, gap: space.xs },
  section: { marginBottom: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, padding: space.m, borderRadius: radius.m, backgroundColor: color.surface1 },
  rowChosen: { backgroundColor: color.surface3, borderWidth: StyleSheet.hairlineWidth, borderColor: color.accentDeep },
  thumb: { width: 96, height: 54, borderRadius: radius.s, backgroundColor: color.placeholder },
  note: { paddingVertical: space.m },
  footer: { paddingHorizontal: space.l, paddingTop: space.m, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
})
