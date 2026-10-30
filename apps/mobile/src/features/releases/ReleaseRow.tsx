import { StyleSheet, Text, View } from 'react-native'
import Ionicons from '@expo/vector-icons/Ionicons'
import { formatSize } from '../../core/services/playback'
import type { Found } from '../../core/services/releases'
import { Press } from '../../ui/press'
import { color, font, radius, space, text } from '../../ui/theme'

// One release of a list: its seeds and a meter (√ of the list's best), what it
// is, its tags, its own name. Find releases and plugins' release lists.

/** 44852 → 44.9k: a seed count fits its column */
function compact(n: number): string {
  if (n < 10000) return String(n)
  return n < 1e6 ? `${(n / 1000).toFixed(n < 100000 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`
}

/** A result row's height (and its placeholder's) */
export const ROW_HEIGHT = 84

export function ReleaseRow({ item, top, onPress }: { item: Found; top: number; onPress: () => void }) {
  const where =
    item.season != null && item.episode != null
      ? `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`
      : item.pack
        ? item.season != null
          ? `Season ${item.season}, every episode`
          : 'Several seasons'
        : item.year
          ? String(item.year)
          : null
  const tags = [item.quality, formatSize(item.size), item.codec, item.kind === 'hls' ? 'Stream' : item.kind === 'file' ? 'File' : null].filter(Boolean) as string[]
  return (
    <Press onPress={onPress} scale={0.98} style={[styles.row, !item.matches && { opacity: 0.6 }]} accessibilityLabel={item.name}>
      <View style={styles.seeds}>
        {item.kind === 'torrent' ? (
          <>
            <Text style={styles.seedCount} numberOfLines={1}>
              {compact(item.seeds ?? 0)}
            </Text>
            <Text style={text.tiny}>seeds</Text>
            <View style={styles.meter}>
              <View style={[styles.meterFill, { width: `${Math.sqrt((item.seeds ?? 0) / top) * 100}%` }]} />
            </View>
          </>
        ) : (
          <Ionicons name="play-circle-outline" size={30} color={color.accent} />
        )}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={text.label} numberOfLines={1}>
          {item.title}
          {where ? <Text style={styles.where}>{`  ${where}`}</Text> : null}
        </Text>
        {tags.length ? (
          <View style={styles.tags}>
            {tags.map((t) => (
              <Text key={t} style={styles.tag}>
                {t}
              </Text>
            ))}
          </View>
        ) : null}
        <Text style={text.tiny} numberOfLines={2}>
          {item.name}
        </Text>
      </View>
    </Press>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: ROW_HEIGHT, paddingVertical: space.m, paddingHorizontal: space.m, borderRadius: radius.m, backgroundColor: color.surface2 },
  seeds: { width: 58, alignItems: 'center', justifyContent: 'center' },
  seedCount: { fontFamily: font.display, fontSize: 20, lineHeight: 22, color: color.accent },
  meter: { width: 40, height: 3, borderRadius: 2, backgroundColor: color.progressTrack, marginTop: space.xs, overflow: 'hidden' },
  meterFill: { height: 3, backgroundColor: color.accent },
  where: { fontFamily: font.medium, fontSize: 13, color: color.textMuted },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  tag: { ...text.tiny, color: color.textSecondary, paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.s, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
})
