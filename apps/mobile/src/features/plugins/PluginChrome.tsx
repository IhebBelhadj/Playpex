import { StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated'
import type { ScreenMobile } from '@playpex/protocol/plugins'
import { useSession } from '../../lib/session'
import { useMorphTag } from '../../state/boundary'
import { Avatar } from '../../ui/avatar'
import { TOP_BAR_HEIGHT, TopBar } from '../../ui/chrome'
import { IconButton } from '../../ui/components'
import { color, font, space, text } from '../../ui/theme'

// The top of a plugin's screen, as the plugin chose it for phones
// (docs/plugins/tv.md "On phones": the manifest's screens[].mobile, or its data
// answer's `mobile`, which wins). Every template draws its content through
// this: it says where the content starts, whether the title is in it, and
// draws the bar over it.
//
//   plain    (default) Back on a dark strip; the title large in the content
//   fold     the title large in the content; as it scrolls away the bar darkens
//            and the title comes into it beside Back
//   app      the app's own top bar (the mark, the server, Search, the profile) with Back
//   overlay  no strip: Back floats over the first row (a picture to the top edge); no title

export type Bar = NonNullable<ScreenMobile['bar']>

const BAR = 56
/** Where a folding title has scrolled under the bar */
const FOLD_AT = 64

export type Chrome = {
  bar: Bar
  /** Padding above the content */
  top: number
  /** The template draws its title at the top of its content */
  titleInContent: boolean
  scrollY: SharedValue<number>
  onScroll: ReturnType<typeof useAnimatedScrollHandler>
}

export function useChrome(bar: Bar): Chrome {
  const insets = useSafeAreaInsets()
  const scrollY = useSharedValue(0)
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y
  })
  const top = bar === 'overlay' ? 0 : bar === 'app' ? insets.top + TOP_BAR_HEIGHT + space.s : insets.top + BAR + space.s
  return { bar, top, titleInContent: bar !== 'overlay', scrollY, onScroll }
}

/** The bar itself, drawn over the content (after it) */
export function PluginBar({ chrome, title }: { chrome: Chrome; title: string }) {
  if (chrome.bar === 'app') return <AppBar scrollY={chrome.scrollY} />
  if (chrome.bar === 'fold') return <FoldBar scrollY={chrome.scrollY} title={title} />
  return <PlainBar strip={chrome.bar === 'plain'} />
}

function PlainBar({ strip }: { strip: boolean }) {
  const insets = useSafeAreaInsets()
  return (
    <>
      {strip ? <View style={[styles.strip, { height: insets.top + BAR }]} pointerEvents="none" /> : null}
      <View style={[styles.back, { top: insets.top + space.s }]}>
        <IconButton icon="chevron-back" label="Back" glass onPress={() => router.back()} />
      </View>
    </>
  )
}

function FoldBar({ scrollY, title }: { scrollY: SharedValue<number>; title: string }) {
  const insets = useSafeAreaInsets()
  const ground = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [0, FOLD_AT], [0, 1], 'clamp') }))
  const name = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [FOLD_AT * 0.6, FOLD_AT], [0, 1], 'clamp'),
    transform: [{ translateY: interpolate(scrollY.value, [FOLD_AT * 0.6, FOLD_AT], [8, 0], 'clamp') }],
  }))
  return (
    <View style={[styles.fold, { height: insets.top + BAR, paddingTop: insets.top }]} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, styles.foldGround, ground]} pointerEvents="none" />
      <IconButton icon="chevron-back" label="Back" glass onPress={() => router.back()} />
      <Animated.Text style={[styles.foldTitle, name]} numberOfLines={1} importantForAccessibility="no">
        {title}
      </Animated.Text>
    </View>
  )
}

function AppBar({ scrollY }: { scrollY: SharedValue<number> }) {
  const { profile, server } = useSession()
  const tag = 'me-plugin'
  const morph = useMorphTag(tag)
  return (
    <TopBar
      server={server?.name ?? ''}
      scrollY={scrollY}
      solidAfter={60}
      onBack={() => router.back()}
      onProfile={() => morph.open(() => router.push({ pathname: '/settings', params: { tag } }))}
      onSearch={() => router.navigate('/search')}
      profile={profile ? <Avatar key={morph.key} id={profile.avatar} name={profile.name} size={34} round tag={morph.tag} /> : null}
    />
  )
}

/** The title at the top of a template's content, when the bar leaves it there */
export function ContentTitle({ chrome, title, size = 'hero' }: { chrome: Chrome; title: string; size?: 'hero' | 'title' }) {
  if (!chrome.titleInContent) return null
  return <Text style={[size === 'hero' ? text.hero : text.title, styles.title]}>{title}</Text>
}

const styles = StyleSheet.create({
  strip: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: color.bar, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
  back: { position: 'absolute', left: space.l },
  fold: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.l },
  foldGround: { backgroundColor: color.bar, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
  foldTitle: { flex: 1, fontFamily: font.display, fontSize: 18, lineHeight: 22, color: color.text },
  title: { paddingHorizontal: space.l, marginBottom: space.l },
})
