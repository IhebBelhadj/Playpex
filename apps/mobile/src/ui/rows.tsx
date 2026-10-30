import { useState, type ReactNode } from 'react'
import { RefreshControl, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useQueryClient } from '@tanstack/react-query'
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated'
import { useCatalogList, type MediaType } from '../lib/catalog'
import { titlesOf } from '../lib/recommend'
import { useSession } from '../lib/session'
import { useMorphTag } from '../state/boundary'
import { openBrowse } from '../state/navigation'
import { Avatar } from './avatar'
import { TAB_BAR_HEIGHT, TOP_BAR_HEIGHT, TopBar } from './chrome'
import { Row } from './components'
import { color, space, text } from './theme'

/** One row of a catalog list (`/catalog/lists/{mediaType}/{list}`) */
export function CatalogRow({ mediaType, list, label, why }: { mediaType: MediaType; list: string; label: string; why?: string }) {
  const query = useCatalogList(mediaType, list)
  return (
    <Row
      label={label}
      why={why}
      titles={titlesOf(query.data?.results)}
      loading={query.isPending}
      scope={`${mediaType}-${list}`}
      onSeeAll={() => openBrowse(mediaType, { list, label })}
    />
  )
}

/**
 * A section's page: the chrome's top (the mark, the server, the profile) over
 * it, its title set large at the top of the content, pulled down to refresh.
 * `overHero`: the page starts with a full-bleed picture and no title.
 */
export function TabPage({ title, overHero, children }: { title?: string; overHero?: boolean; children: ReactNode }) {
  // One tag per section: every tab's top bar stays mounted, and a tag must be unique on screen
  const avatarTag = `me-${title ?? 'home'}`
  const morph = useMorphTag(avatarTag)
  const insets = useSafeAreaInsets()
  const { profile, server } = useSession()
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const scrollY = useSharedValue(0)
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y
  })

  async function refresh() {
    setRefreshing(true)
    await queryClient.invalidateQueries()
    setRefreshing(false)
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingTop: overHero ? 0 : insets.top + TOP_BAR_HEIGHT + space.s, paddingBottom: TAB_BAR_HEIGHT + insets.bottom + space.xxxl }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={color.accent} colors={[color.onAccent]} progressBackgroundColor={color.accent} progressViewOffset={insets.top + TOP_BAR_HEIGHT} />
        }
      >
        {title ? <Text style={[text.marquee, styles.title]}>{title}</Text> : null}
        {children}
      </Animated.ScrollView>
      <TopBar
        server={server?.name ?? ''}
        scrollY={scrollY}
        solidAfter={overHero ? 260 : 60}
        onProfile={() => morph.open(() => router.push({ pathname: '/settings', params: { tag: avatarTag } }))}
        onSearch={() => router.navigate('/search')}
        profile={profile ? <Avatar key={morph.key} id={profile.avatar} name={profile.name} size={34} round tag={morph.tag} /> : null}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  title: { paddingHorizontal: space.l, marginBottom: space.xl },
})
