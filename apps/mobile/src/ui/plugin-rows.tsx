import { FlatList, StyleSheet, Text, View } from 'react-native'
import { Image } from 'expo-image'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Ionicons from '@expo/vector-icons/Ionicons'
import type { PluginCard, PluginRow, PluginRowPage } from '@playpex/protocol/plugins'
import { askPlugin, pluginImage, runCard, usePlugins } from '../lib/plugins'
import { useApi, useProfile, useSession } from '../lib/session'
import { ProgressBar, ROW_LIST, RowHeading, RowSkeleton, POSTER_WIDTH } from './components'
import { Press } from './press'
import { useToast } from './toast'
import { usePlayEffect } from '../state/playback'
import { color, motion, radius, space, text } from './theme'

// A plugin's row drawn by the core (docs/api/plugins.md): its cards in one of
// four shapes, each opening its intent or answering its call. A paged row asks
// the plugin for its first page.

const SHAPES = {
  poster: { width: POSTER_WIDTH, ratio: 1.5 },
  portrait: { width: 96, ratio: 1.33 },
  still: { width: 220, ratio: 0.5625 },
  compact: { width: 84, ratio: 1 },
} as const

export function PluginRowView({ plugin, row }: { plugin: string; row: PluginRow }) {
  const api = useApi()
  const profile = useProfile()
  const paged = 'page' in row ? row.page : null
  const page = useQuery({
    queryKey: ['plugins', profile.id, 'row', plugin, row.key],
    enabled: !!paged,
    staleTime: 5 * 60 * 1000,
    queryFn: () => askPlugin<PluginRowPage>(api, profile.id, plugin, paged!.data, { ...(paged!.args ?? {}), page: 1 }).then((a) => a.data?.items ?? []),
  })
  const items = 'items' in row ? row.items : page.data
  const shape = SHAPES[row.variant ?? 'poster']
  const source = usePlugins().data?.plugins.find((p) => p.id === plugin)?.name

  if (paged && page.isPending) {
    return (
      <View style={styles.row}>
        <RowHeading title={row.title} why={source} />
        <RowSkeleton width={shape.width} ratio={shape.ratio} />
      </View>
    )
  }
  if (!items?.length) return null
  return (
    <View style={styles.row}>
      <RowHeading title={row.title} why={source} />
      <FlatList
        {...ROW_LIST}
        horizontal
        data={items}
        keyExtractor={(c) => String(c.key)}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: space.l, gap: space.s + 2 }}
        renderItem={({ item }) => <Card plugin={plugin} card={item} shape={shape} round={row.variant === 'compact'} />}
      />
    </View>
  )
}

export function Card({ plugin, card, shape, round }: { plugin: string; card: PluginCard; shape: { width: number; ratio: number }; round?: boolean }) {
  const api = useApi()
  const profile = useProfile()
  const session = useSession()
  const queryClient = useQueryClient()
  const toast = useToast()
  const play = usePlayEffect()
  const source = usePlugins().data?.plugins.find((p) => p.id === plugin)?.name
  const uri = pluginImage(session, plugin, card.image)
  const watched = card.badges?.includes('watched')
  const textBadges = (card.badges ?? []).filter((b): b is { text: string } => typeof b === 'object')

  return (
    <Press
      style={{ width: shape.width }}
      accessibilityLabel={card.title}
      onPress={() =>
        runCard(api, profile.id, plugin, card, {
          toast: (t, tone) => toast(t, { source, tone }),
          refresh: () => queryClient.invalidateQueries({ queryKey: ['plugins', profile.id] }),
          play,
        })
      }
    >
      <View style={[styles.image, { width: shape.width, height: shape.width * shape.ratio }, round && { borderRadius: shape.width / 2 }]}>
        {uri ? <Image source={uri} style={StyleSheet.absoluteFill} contentFit="cover" transition={motion.base} /> : <Ionicons name="film-outline" size={28} color={color.textDim} />}
        {textBadges.length ? (
          <View style={styles.badges}>
            {textBadges.map((b) => (
              <Text key={b.text} style={styles.badge}>
                {b.text}
              </Text>
            ))}
          </View>
        ) : null}
        {watched ? <Ionicons name="checkmark-circle" size={20} color={color.accent} style={styles.watched} /> : null}
        {card.progress != null ? <ProgressBar ratio={card.progress} style={styles.progress} /> : null}
      </View>
      {card.variant === 'still' || shape === SHAPES.still || round ? (
        <>
          <Text style={[text.label, { fontSize: 14, marginTop: space.s }, round && { textAlign: 'center' }]} numberOfLines={2}>
            {card.title}
          </Text>
          {card.subtitle ? (
            <Text style={[text.tiny, round && { textAlign: 'center' }]} numberOfLines={1}>
              {card.subtitle}
            </Text>
          ) : null}
        </>
      ) : !uri ? (
        <Text style={[text.small, { marginTop: space.xs }]} numberOfLines={2}>
          {card.title}
        </Text>
      ) : null}
    </Press>
  )
}

const styles = StyleSheet.create({
  row: { marginBottom: space.xxl },
  image: { borderRadius: radius.m, backgroundColor: color.surface2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  badges: { position: 'absolute', top: space.s, left: space.s, flexDirection: 'row', gap: space.xs },
  badge: { ...text.tiny, color: color.onAccent, backgroundColor: color.accent, paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.s, overflow: 'hidden' },
  watched: { position: 'absolute', top: space.s, right: space.s },
  progress: { position: 'absolute', left: space.s, right: space.s, bottom: space.s },
})

